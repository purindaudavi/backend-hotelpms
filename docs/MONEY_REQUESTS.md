# Staff money requests and opening funds

Implemented and verified on 2026-11-06 (Asia/Colombo). This extends the existing
Financials 2 comparison. It does not connect to or transfer money through a bank.

## Access and navigation

- **Money requests** is a property sidebar page for Owner, Administrator, Finance,
  Front Desk and Housekeeping. Financials 2's Add Record → Request money opens it.
- Owner/Admin see the property requests and recorded funds. Other staff see only
  their own requests and receipts; they cannot read the property's funds endpoint.
- All four staff roles can submit their own request. Recipient/requester identity
  comes from the authenticated account, never browser-supplied names or user IDs.
- **Only Owner** approves, rejects, records payment or settles an advance.
  Requesters can cancel their own pending requests. Admin cannot self-approve.
- Each request has an MR reference, creator/role, amount/currency, purpose,
  status, actor/time history, optional receipts and payment reference.

## Money and statuses

Pending → Approved → Paid. Rejection/cancellation creates no financial movement.
Approval also does not deduct money. Owner pays outside the PMS and then records
the actual payment date/method/reference with an explicit paid confirmation.
This posts exactly one `money_request` outflow. The property's existing transaction
guard and optimistic versions protect concurrent/repeated transitions.

The all-date balance is calculated separately for each currency:

**Opening + posted guest payments + returned advances - completed expenses,
supplier payments, refunds, legacy withdrawals and staff payments.**

Invoices, non-cash credit notes, unpaid confirmed bookings, pending/approved
requests and historical Night Audit inflow flags do not contribute cash. A paid
deposit contributes even when its reservation is only Confirmed. The balance is
a record-based cash/bank total; it is not a live or reconciled bank balance.

## Owner opening balance

Owner opens Money requests → Set opening balance. Enter currency, a non-negative
amount, an explanatory note and the required confirmation. This is the hotel's
money held **before the movements already recorded in the PMS**, not today's bank
balance if that already contains recorded guest payments. A preview shows the
result before saving.

The opening is saved once per property/currency, with Owner/time/note and an audit
entry. Duplicate/concurrent setup cannot add it twice. Admin can view but not set
it. Zero is a valid opening. Different currencies remain separate. There is no
edit/reset endpoint for this initial value; do not enter an unverified amount.
Opening funds are not guest receipts, revenue or a financial transaction payment.

## Expenses, advances and receipts

- **Work expense:** when Owner marks Paid, a linked expense records the cost. Its
  cash is recorded only by the request, not by a second expense transaction.
- **Advance:** payment initially records cash out, not a final expense. After the
  work, Owner reviews receipts, enters actual spending and a settlement note.
  The actual spending becomes a linked expense without another cash deduction.
- If spending is less than the advance, settlement requires confirmation that the
  unused difference was actually returned. One `money_request_return` inflow adds
  that difference back. An advance can only be settled once.
- Linked expenses cannot be independently voided through Expenses and are omitted
  as duplicate cash events in Financials 2. Do not manually create another expense
  or bill for the same staff payment. This workflow is for work funds; existing
  supplier bills should be paid through their linked bill payment workflow.
- Owner/requester may attach up to three JPG/PNG/PDF files of up to 3 MB each.
  Files are byte-type checked, authenticated and scoped to the request/property.
  Admin can view property proof, but can upload only to their own requests.
  Uploading proof does not deduct funds. Receipt binaries are omitted from list
  and detail JSON; downloads use a protected endpoint and attachment headers.
- Owner and the requester receive separate notification events for creation and
  status changes. Notification links open the specific request; unrelated staff
  cannot read/mark these alerts as read.

Legacy withdrawal history and pending records remain available. New legacy
Admin/Finance records stay pending; only Owner can approve/complete/reject/void.
The modern staff workflow uses Money requests and handles all four staff roles.

## Manual test on a test property

1. Restart the backend if it is not watching changes, then refresh the frontend.
2. As Owner, open Money requests → Set opening balance. Use a known test opening,
   such as LKR 2,000. Confirm the balance rises by 2,000 and a second LKR setup is
   blocked. Guest payments received must not increase because of the opening.
3. An unpaid confirmed reservation must not change this balance. Record a real/test
   guest payment of 5,000 and verify the balance rises by 5,000.
4. As Front Desk, Admin, Finance or Housekeeping, request 1,000 for work. Choose
   Advance when money is needed before buying anything. Pending deducts nothing.
5. As Admin, verify property funds are visible but Approve/Mark Paid controls are
   absent. As Owner, approve the request. Approved still deducts nothing.
6. After the external test payment, Owner opens the approved request, fills actual
   date/method/reference, confirms paid and chooses Mark Paid. Balance falls by
   exactly 1,000. A repeated/concurrent payment must not deduct another 1,000.
7. Attach a receipt. Balance must stay unchanged. Requester sees the same status.
8. As Owner, settle an advance with 800 spent and 200 actually returned. Confirm
   the return. Balance rises by 200; one cost of 800 is recorded with no second
   cash outflow. The same advance cannot be settled again.
9. Verify another staff login cannot open someone else's request/receipt and
   another property's login cannot read the request, funds or opening setup.

## Verification and implementation references

- `node --test`: **275 tests passed** after opening balance integration.
- Frontend `tsc --noEmit --incremental false`: passed.
- `node scripts/live-money-requests-smoke.js`: **69 authenticated MongoDB/API
  checks passed**, including four staff roles, scoped records/files/notifications,
  concurrency, no duplicate cash/cost, opening-only-once, different currencies,
  tenant boundaries and legacy Owner-only approval. All disposable test fixtures
  were removed and cleanup was verified.
- Isolated browser walkthrough: four-role permissions, request/approve/pay,
  receipt upload, settlement/change, opening preview/confirmation/duplicates,
  Admin restrictions, notification deep link and light/dark/mobile rendering.
- Real hotel records were not changed by the tests. Smoke tests create disposable
  accounts/properties and financial fixtures; keep using a disposable environment.

Backend: `routes/money-requests.js`, `services/money-request.service.js`,
`services/recorded-funds.service.js`, money request/event/opening models.
Frontend: `money-requests-page.tsx`, `opening-balance-form.tsx`, Financials 2
summary/activities, property navigation/permissions and notification types.
Browser harness: ignored `tmp/money-request-preview.cjs`.
