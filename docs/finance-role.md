# Finance property role

Implemented 2026-10-30 (Asia/Colombo). Finance is a property staff role,
independent of the login's global role or access at other hotels. Reports remains
a separate future staff role. No real account was reassigned during testing.

## Assign and use

1. Staff registers a normal account first.
2. Owner/Admin opens **Users & access**, enters the registered email, chooses
   **Finance**, and grants access. Existing members can have their role changed
   to Finance using their role dropdown. No attendant link is needed.
3. The employee signs in or refreshes/reopens the property. The sidebar shows
   Dashboard, Reservation → Bookings, Financials (without Integrations), Reports
   and Night Audit. Removing access blocks the next API request immediately.

## Capabilities

| Area | Finance access |
| --- | --- |
| Dashboard | All-date recorded guest payments, unpaid invoice balances, posted expenses, unpaid supplier purchases, pending refunds and pending withdrawals, separated by currency |
| Reservation billing | Read-only guest contact, reservation reference, rooms, stay dates and saved pricing; no operational edit/check-in/check-out controls |
| Transactions | Read financial transaction records/history |
| Invoices | Create/edit draft invoices, issue invoices, record payments and read balances/history |
| Credit Notes | Create/edit drafts; issuing or voiding is blocked for Finance |
| Refunds | Create/edit pending refunds; completing or voiding is blocked for Finance |
| Withdrawals | Submit pending requests and view history; approval/completion/void is blocked for Finance |
| Purchases and Payables | Record purchases, inspect unpaid purchases and record supplier payments |
| Expenses | Record posted expenses; posted-record voids are blocked for Finance |
| Receivables | Read outstanding invoices and record collections through invoice payments |
| Profit & Loss | View existing summary/targets; changing/removing profit targets is blocked |
| Reports | Generate/export the eight permitted financial reports and read their scoped generation history |
| Night Audit | Shared detailed screen, current checks and closed history; separate Reviewed/Flagged review of completed audits with notes/actor/time/history. No posting, operational step review, override, close-note edit, report-pack generation, reopening or business-date advancement |

Financial reports: Collection Report, Deposit Ledger, Revenue Report, Revenue
Forecast, Customer Balance Summary, AR Aging Summary, In-House Guest Ledger,
and Travel Agent Performance. Unsupported Trial Balance/Reports Profit & Loss/
Invoice Daybook are not enabled by this role. Financials Profit & Loss remains
the existing separate page.

Finance notifications contain the eight financial types: invoices, payments,
credit notes, refunds, withdrawals, purchases, expenses and transactions. Booking
and housekeeping notifications are excluded before pagination/counts/read
actions. Mark all read stays scoped to allowed types for later role changes.
Pending withdrawals are correctly described as awaiting approval.

Night Audit was extended on 2026-10-30 with optional Front Desk delegation and
independent Finance review. See [workflow and step-by-step testing](night-audit-delegation-review.md).

## Withdrawal approval

Finance POST `/api/withdrawals` always creates **pending**, ignoring browser
claims of completed status/approver identity. The request records its verified
requester and timestamp. Its `effective_amount` is zero, it is excluded from
completed totals, and no withdrawal transaction is posted yet.

Owner/Admin opens **Financials → Withdrawals → View** and either:

- Rejects the pending request with a reason (stored as voided, without posting
  money), or
- Confirms the actual money-received date/time and approval note, then chooses
  **Approve and Record**. Only do this after the recipient received the money.

Approval uses a current version and the shared inventory transaction guard.
Status, approver/time/note, ledger transaction and audit log commit together.
Two simultaneous approvals produce one completed withdrawal and one ledger
transaction; the stale attempt returns 409. Archive locking also applies.
Existing completed withdrawals remain completed and keep their history.

The existing Owner/Admin direct-record-completed flow remains available. The
existing legacy General member role still has broad operational permissions;
assign Finance for the restrictions described here. This change does not remove
legacy privileges globally. The new completion endpoint itself requires an
actual property Owner/Admin.

Updated 2026-11-04: new withdrawals select this property's actual Owner or
Administrator account; the fixed ASIRI PERERA payee was removed. Finance sees
**Requested recipient**, with name/role options and separate requester and
approver details. Existing completed records keep their historical payee;
unlinked legacy pending requests must be rejected and recreated. Pending dates
remain request dates/awaiting approval. See [recipient validation and tests](withdrawal-recipients.md).

## Boundaries and implementation

Finance cannot manage property settings/access, create attendants, assign
housekeeping, change rooms/rates, use Channel Manager/IBE/integrations, mutate
reservations or their status, fetch guest profiles/identity attachments, close
Night Audit, change profit targets, or void posted invoices/payments/credits/
refunds/withdrawals/purchases/expenses. Role changes are checked on every API
request, not taken from body/query/header role claims.

The property schema, staff-grant routes, labels, frontend page allowlist and
backend explicit API allowlist all recognize Finance. The app shell isolates
Finance's reservation cache, starts with empty data and loads only the billing
projection; it does not read the owner room catalog or seed operational data.
Property branding metadata omits settings/channel credentials. Reservation list
and detail responses whitelist billing fields and omit internal notes, occupant
documents, attachments and operational logs even with `details=true`.

Report catalog and generation history are filtered to permitted types in a
property context. Direct access to another report's saved output is denied.
An authenticated unscoped catalog can still list report names, as before; it
does not grant report generation/history/data access.

The Finance overview is based on persisted financial records, not booking
reservation value. Guest payments are before completed refunds and are not a
bank balance. Invoices marked draft/voided do not contribute unpaid balances.
Refresh is manual. Existing financial/report calculation limitations and the
local supplier/agent-directory UI remain separate work; this role does not add
shared supplier/agent persistence, bank transfers or a general ledger.

## Test locally

Use registered disposable Finance and Owner/Admin accounts in separate browser
sessions, and a test property with a saved guest/reservation.

1. Grant Finance. Verify its dashboard/sidebar, read-only Bookings and eight
   report choices. Settings, Front Desk, Housekeeping and Integrations URLs must
   show restricted access; the corresponding APIs must return 403.
2. Create/issue an invoice and post a payment. Draft credit creation should work
   while Issue Credit Note and payment/invoice Void are absent/blocked.
3. Owner/Admin issues the credit. Finance can request the resulting eligible
   refund; only a privileged account completes it. Recording a refund request
   alone must not reduce posted receipts or prove an external money transfer.
4. Finance requests a withdrawal. Verify Pending, no completed total and no
   withdrawal ledger entry. In Owner/Admin, View → approve with actual date/note.
   Verify Completed, approver history and exactly one posted withdrawal.
5. Approve the same request in two sessions. One succeeds; the other must fail
   with a stale/closed-state conflict. Finance cannot complete it directly.
6. Add records in LKR and USD. The overview must show separate currency amounts.
   Revoke Finance access; subsequent requests must immediately return 403.

Verification: **250 backend tests passed**, frontend TypeScript passed, and
isolated desktop/mobile browser checks passed for navigation, dashboard,
readonly billing, restricted invoice/credit/refund controls, report scope,
Night Audit review, withdrawal submission and Owner/Admin approval. UI checks
use simulated APIs separately from database acceptance.

`npm run smoke:finance-role` passed **40 MongoDB-backed checks**, including real
grant/revocation, invoices/payments, draft credits and pending refunds, purchases/
expenses, currency separation, pending withdrawals, concurrent approval and
report restrictions. Disposable accounts, hotel, guest/room/reservation records,
billing/money records, reports, counters, guards and audits were removed and
cleanup verified. No real financial records were changed. A production frontend
build was not run against the active development server.

New APIs: GET `/api/finance/overview`; POST
`/api/withdrawals/:withdrawalId/complete` with version, note and money_received_at.
All existing financial endpoints retain their normal property scoping and
validation, with Finance authorization applied before handlers.
