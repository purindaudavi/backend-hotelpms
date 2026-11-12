# Financials 2 comparison view

2026-11-06 follow-up: [Money requests and opening funds](MONEY_REQUESTS.md) adds
Owner-paid staff requests for Front Desk/Admin/Finance/Housekeeping and the
Owner/Admin funds card. Owner can set one opening per property/currency.
Legacy withdrawal approval/void controls were subsequently restricted to Owner;
the original comparison-screen preservation statement below describes the
2026-11-05 snapshot, not this later access-policy change.

Implemented 2026-11-05 for side-by-side evaluation. The existing Financials menu,
routes and original financial screen files remain available. No existing
Financials module component was edited for this comparison; file hashes were
checked against the pre-change snapshot.

## Open and compare

Sign in as property Owner, Administrator or Finance. Refresh the workspace and
open **Financials 2**, immediately below the original Financials group. The new
route is `/properties/<property-id>/financials-2`. Its comparison link opens the
original Financials → Transactions page. Original links, notification targets
and payment/approval endpoints are unchanged.

Both views read and write the **same property records**. Financials 2 is an
alternative interface, not an isolated database or simulation. A payment,
credit, refund or withdrawal recorded from it is real in that environment and
appears in the original view after refresh. Tests used isolated mocks only.

## Layout and functions

Supplier payment Other details added on 2026-11-06: choosing Other in the
Financials 2 bill payment form reveals **Please specify payment method**,
required with a 150-character limit and whitespace validation. Switching to a
standard method hides and clears that field. The description is stored as
`Purchase.payment_method_details`, separately from `payment_reference`, and
appears in paid-bill details, supplier-payment activity/search and activity CSV.
Paid-bill details also show the recorded method, date and reference. Supplier
payment transaction descriptions retain the specified method for history.

The API rejects blank, non-string or oversized Other descriptions when the new
field is supplied. Calls from original Financials that omit this new field remain
compatible; historical Other records show **Other (not specified)**. No migration
or modification of existing payments is needed. Validation: 17 targeted model,
API, Financials 2, pagination and Finance-access tests; TypeScript; isolated browser
checks for required/conditional fields, persistence after reload, CSV and themes.

Bill payment visibility added on 2026-11-06: All Activity keeps the original
transaction status (for example, Posted) and adds a current **Paid** or **Unpaid**
badge to Bill rows using the linked purchase's status. Unpaid is orange and Paid
is green. Bills missing their source document, voided bills and separate supplier
payment events do not get a guessed payment badge. The activity status filter
matches Paid/Unpaid as well as the original record status; combine activity type
Bill with Paid or Unpaid to separate supplier bills. CSV adds Bill payment status.
Saving a supplier payment reloads the data and updates the original Bill badge.
Checks: 9 Financials 2 tests, TypeScript and an isolated browser walkthrough of
unpaid-to-paid, filters, CSV and light/dark/mobile rendering. No live financial
records were changed by verification.

Bill wording aligned on 2026-11-06: the action is **Record a bill**, the record
type is **Bill**, and the form uses **Save unpaid bill**. Activity filters/rows,
CSV type labels, bill details/void prompts, unpaid-list headings, summary labels
and local messages now use the same wording. Supplier identity fields and the
separate **Supplier payment** event retain their meanings. This is display text
only; purchase APIs, stored IDs, calculations and original Financials screens
are unchanged.

Activity ordering corrected on 2026-11-06: financial dates remain newest first;
within each date, records use their creation timestamp in descending order.
This prevents a newly recorded bill from appearing below older same-day bills
or payments. Older records without a valid creation timestamp use their event
date, with descending record ID as a stable tie-breaker. Editing an old document
does not promote it as a new event. Ordering and existing cash/access checks
are covered by `node --test test/financials2.test.js`.

- **All Activity:** posted/voided transaction history plus unposted drafts and
  pending requests. Source document IDs prevent listing an invoice or credit
  twice when its transaction already exists. Supplier bill and supplier payment
  remain distinct events. Search, currency/date/type/status filters, Money In,
  Money Out, Withdrawals, Bills & credits, Drafts & requests, pagination and CSV.
- **Bills / Invoices:** invoice list including drafts, paid and credited records.
  Search/filter, total, paid, credit, remaining balance, refund due and overdue
  indication. Opens the existing InvoiceDrawer for invoice issuance, payment
  recording, credit creation and refunds, with original server validation.
- **Unpaid Bills:** guest/customer balances from issued invoices, plus unpaid
  supplier purchases. Guest payment opens the invoice payment form rather than
  immediately posting the whole balance as method Other. Supplier payment asks
  for method, reference, date and confirmation that full payment was received.
- **Summary:** recorded guest receipts, expenses/supplier payments, refunds,
  withdrawals, net movement, outstanding guests/suppliers and pending withdrawals,
  separated by currency. Date filters use transaction date for movements and
  original document date for outstanding balances. Search only filters lists.
  The original Profit & Loss report is optionally embedded here with its own
  period filters and unchanged accounting calculations.
- **Add Record:** receive a guest payment, create a guest invoice, create a credit
  note, record a refund, record/request a withdrawal, record a paid expense or
  record a supplier bill. Invoice-related actions first select the bill and then
  use its existing action controls. Supplier/expense forms post to existing APIs.
- **Withdrawals:** comparison adapters preserve current Owner/Admin recipient
  selection, Finance pending requests, Owner/Admin approval/rejection and history.
  Original withdrawal screen files were not modified.
- **Integrations:** remains available in the original Financials group. This
  comparison does not change provider configuration or add payment transfers.

Owner/Admin approvals remain necessary for credit issuance and refund/withdrawal
completion. Finance can prepare drafts/requests and record permitted payments and
costs. Front Desk, Housekeeping and Demo cannot access Financials 2. The legacy
General member role retains its existing broad operational access; this view
does not grant it new server permissions.

## Totals and accounting boundaries

Cash summaries use actual posted payment/outgoing transaction types. An invoice,
purchase bill or credit note does not count as cash. Pending requests, drafts and
voided records are excluded from completed money movements. Known legacy Night
Audit inflow entries are shown as **Review / Not a guest payment**, excluded from
cash summaries. This is a presentation rule in Financials 2, not a migration or
correction to historical transactions or the old reports.

The remaining Night Audit revenue recognition, tax and invoice accounting issues
discussed earlier are not fixed by this UI. Original Profit & Loss calculations
are reused, not certified or rewritten. Cash summaries are not bank/drawer
balances. Costs should be entered once, not as both a Purchase and an Expense.

## Compatible API addition

Purchases and Expenses GET endpoints now accept optional `page` and `limit`
parameters and return pagination metadata when `page` is supplied. This allows
Financials 2 to load complete lists rather than silently stopping at 200 records.
Calls without `page` keep their previous response shape and 200-record default.
No write endpoint or accounting behavior changed.

## Manual walkthrough

1. Open Financials 2 as Owner/Admin. Check all four tabs and the comparison link.
   Confirm the old Financials group still contains every previous link.
2. Use a disposable test invoice for LKR 13,000 with LKR 5,000 paid. Under Unpaid
   Bills → Guests, open it and record a partial payment. Verify the balance in
   both new and original invoice screens after refresh.
3. From Add Record, choose Create credit note. Select the invoice, create a draft,
   then locate it in Drafts & requests and issue it as Owner/Admin. Finance must
   have no issuance action. Verify bill balance versus refund due.
4. For a fully paid invoice with an issued credit/refund due, create a pending
   refund. Find it under Drafts & requests, inspect it, and complete only after
   actually returning the money. Verify Money Out and original invoice history.
5. Record a paid test expense. Verify Money Out, Summary and original Expenses.
6. Record a supplier bill and find it under Unpaid Bills → Suppliers. After paying
   it, open the bill and record its full payment with method/reference. It should
   leave Unpaid Bills and show a supplier payment event.
7. As Finance, request a withdrawal selecting a property Owner/Admin recipient.
   It stays pending and contributes zero to completed Money Out. As Owner/Admin,
   inspect it, enter the receipt time/note and approve after actual handover.
8. Compare filters, multiple currencies, pending versus completed amounts and CSV
   output. Open Summary → existing Profit & Loss if needed. Test desktop/mobile
   and light/dark modes.
9. Front Desk and Housekeeping should not see Financials 2; a direct link should
   show restricted access. Their original permitted screens still work.

## Validation

- Full backend suite: 264 tests passed, including five new comparison data/access
  tests and two API pagination compatibility tests.
- Frontend TypeScript compilation passed.
- Isolated Chrome walkthrough: partial guest payment, supplier payment, expense,
  Finance withdrawal request, restricted credit/refund actions, Owner/Admin
  issuance/refund completion/withdrawal approval, multiple invoice pages,
  currencies, empty/error/retry states, original Invoices view and role denial.
- Desktop/mobile screenshots and overflow checks; light/dark comparison.
- Original Financials component hashes checked unchanged. No existing hotel,
  account or financial record was changed by the verification.

Ignored local browser helper: `tmp/financials2-preview.cjs`; screenshots under
`tmp/financials2-preview/`. Backend tests: `test/financials2.test.js` and
`test/financial-list-pagination.test.js`. Companion frontend tests can use
`PMS_FRONTEND_PATH` when the frontend is not at the default sibling path.
