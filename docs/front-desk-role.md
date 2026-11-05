# Front Desk property role

Implemented 2026-10-23; extended 2026-10-27 (Asia/Colombo). This is the first department-specific role.

## Access

| Area | Front Desk |
| --- | --- |
| Dashboard | Operational overview: arrivals, departures and current occupancy |
| Front Desk, bookings, arrivals, departures and in-house | Create/edit reservations, assign rooms and use existing lifecycle actions |
| Guest profiles and occupants | View/update guest details and manage reservation occupants |
| Rooms, rates and inventory | Read only; inventory keeps its existing date/availability calculations |
| Housekeeping | View readiness/history, request cleaning and directly assign existing available same-property attendants; no attendant creation or cleaning/inspection completion |
| Checkout | Review recorded charges/invoices/payments; server blocks checkout while unsettled |
| Travel agents | View contact records and choose saved agents for bookings; no agent master edits/performance analytics |
| Invoices | View guest invoices and record payments against issued invoices |
| Reservation documents | Upload/download/remove reservation attachments |
| Guest email | Existing confirmation, lifecycle and reminder emails; no general email composer |
| Notification bell | New bookings, reservation-linked guest invoices and posted guest payments only; individual/all-read actions apply to the signed-in user |
| Restricted | Refunds, credits, voids, booking deletion, master room/rate changes, housekeeping staff creation and cleaning/inspection updates, business-block administration, settings/staff, channels, Night Audit, financial ledgers and general reports |

Confirmed bookings continue to generate their normal automatic invoices. Front
Desk cannot manually create/edit/issue/void invoice documents. Cancellation and
no-show operations still follow existing financial safeguards; an owner/admin
must handle credit notes/refunds when those safeguards require corrections.

Night Audit and shift-only reports are not included in this role. They require
separate future permission/reporting work; working a night shift does not grant
extra access automatically. Notifications now have a server-filtered Front Desk
feed (see below); restricted financial categories and ledger pages remain blocked.

## Assign and test

1. Restart the backend if it is not running with automatic reload, and refresh
   the PMS. Sign in as an existing property owner or administrator.
2. Open **Settings → Users**, or **Your properties → Access**. Enter an existing
   registered account's email, choose **Front Desk**, then **Grant access**.
   The role can also be selected beside an existing general member.
3. Sign in as that staff member in a separate browser profile/private window.
   The property/workspace should show **Front Desk**. Its sidebar should show
   operational modules and **Financials → Invoices**, without settings,
   channels, Night Audit, Reports or the other financial pages.
4. Create a normal reservation using a configured rate plan. Select a room,
   add guest details and save. Check its automatic invoice when confirmed.
   Price and FOC inputs must be disabled; rate-plan creation and booking Delete
   must be absent. Try check-in, a permitted same-type room move and checkout
   with the existing occupancy/financial safety rules satisfied.
5. Open a guest invoice with an outstanding balance and record a test payment.
   The invoice/reservation balance should update. No refund, credit, payment
   void or invoice void action should appear.
6. View Rooms, Rates and Inventory. Search/date filters remain usable, but
   master-data edits and price saves are blocked. In Housekeeping, existing
   active attendants may be assigned; cleaning updates and staff creation stay blocked.
7. Paste `/properties/PROPERTY_ID/settings/users`, `/reports`, `/night-audit`
   or `/financials/refunds` into the address bar (after the property prefix).
   The app should show **Access restricted**, without mounting that module.
   Direct API requests to those restricted operations must return 403 too.
8. As owner/admin, change a general member to Front Desk and reload that user's
   page. Test the restrictions with their existing login. Revoke their access
   and confirm the next property API request fails. Other properties keep
   their independent roles.

Owners alone can appoint/remove administrators. Administrators can assign,
change or remove Front Desk/general-member access. A Front Desk account cannot
change its own role or grant access to other people. These changes are audited.

## Pricing and payment safeguards

- New/repriced Front Desk bookings use server-side rate-plan quotes, including
  occupancy supplements, daily prices, stop-sell and stay restrictions.
- Front Desk cannot set complimentary rooms, change approved overrides or
  bypass approval flags. An unchanged historical price/FOC arrangement may be
  retained while editing non-pricing details. Repricing an approved override
  requires an owner/admin.
- Submitted financial summaries do not set revenue or paid totals: new totals
  are calculated server-side, and saved payments/adjustments are preserved.
- Travel-agent commission terms come from the saved active same-property agent
  or the reservation's unchanged historical agent snapshot.
- Payment submission cannot set `status: refunded`, void an existing payment
  or credit a different currency to the reservation balance.
  Existing payment records do not themselves move money through a gateway.

These extra quote/summary checks are scoped to Front Desk. The broader audit's
pricing/reconciliation work for legacy unrestricted roles is not marked fixed.

## Implementation and verification

Membership remains in `member_ids`. Non-admin staff role assignments are stored
in `staff_roles` and require unique existing non-owner/non-admin members.
Existing owners/admins/general members need no migration. No existing general
member is silently converted to Front Desk; assign the role explicitly.

The server checks a restricted-role API allowlist on every property request.
Unknown operations are denied. The frontend uses matching page restrictions,
filtered navigation and permission-aware actions. Role changes apply to the
next API request; reload other browser tabs to refresh labels and controls.

Run `npm run check:access` for focused role and HTTP authorization checks;
`npm test` for the backend suite; and `npm run typecheck -- --incremental false`
in `new-pms` for frontend types. Automated model/HTTP tests use isolated fixtures
and do not change hotel data. Live hotel acceptance uses the steps above.

Verification on 2026-10-23: backend suite and frontend TypeScript checks passed.
Browser checks with isolated API fixtures verified filtered navigation, blocked
settings URLs, disabled price/FOC controls, limited invoice actions, payment
submission/balance refresh and mobile dark-mode read-only views. Live database
acceptance remains the manual checklist above; production build was not run
against the active development server.

Manager, Housekeeping, Finance and Reports roles, employee/login linkage and
subscription enforcement remain separate work.

## Housekeeping assignment and checkout review (2026-10-27)

### How to use and test

1. As Owner/Admin, configure at least one active physical room and create an
   active attendant in **Housekeeping Board > Assign > +**. This is a
   housekeeping attendant record, not a new login or property access grant.
2. As Front Desk, open **Housekeeping > Housekeeping Board**. Pick a room that
   is not occupied, out of order or under maintenance. Click **Assign**, select
   an existing active attendant, then **Assign**. The card shows the attendant;
   Activity/history records the assignment. Assigning does not mark a room clean.
3. Front Desk must not see the add-attendant **+**, Start/Complete Cleaning or
   housekeeping Day End controls. Direct create/start/complete/inspect requests
   still return 403. Owner/Admin retain their existing cleaning workflow.
4. Create a confirmed test booking, check it in, and leave an unpaid invoice.
   Open it from the Front Desk grid (or edit from Bookings), change **Status**
   to **Checked-out**, then save. **Review checkout** opens instead of immediately
   checking out. It lists recorded service/accommodation lines, total, paid,
   credits and unpaid balance per invoice/currency. **Confirm checkout** is disabled.
5. Click **View invoice / payment** and record payment on the issued invoice.
   Close the invoice drawer; the review refreshes. Use **Refresh balance** if
   another staff member recorded the payment. A partial payment must leave
   checkout blocked; once every invoice is settled, confirm checkout.
6. Confirm the reservation becomes Checked-out and the room becomes Available
   and Dirty. Assign an attendant to prepare it for the next guest.
7. Additional tests: an unpaid second service invoice blocks checkout even when
   the room invoice is paid; draft charges require Owner/Admin review; a credit
   counts only once issued; currencies cannot offset each other. Preview a settled
   bill in one tab, void its payment as Owner/Admin in another, then confirm from
   the first tab: the server must reject checkout and keep the guest checked in.

### Billing safety and limits

- New `GET /api/bookings/reservations/:id/checkout-review` is property-scoped.
  Checkout recomputes it server-side within the inventory transaction; a saved
  preview, forged balance or `force` flag cannot bypass it, including for owners.
- Balances derive from actual posted/refunded payments, issued credits and
  completed refunds, not a browser-provided or cached paid total. Each active
  invoice must settle independently; accommodation is not counted a second time
  by adding the reservation's total to its invoice total.
- Invoice, credit and refund mutation routes now share the property inventory
  transaction guard with checkout/reservations/housekeeping. Concurrent financial
  writes before checkout are serialized and the transaction retries its checks.
- Positive draft charges, inconsistent billing/currencies, unallocated legacy
  deposits, all-voided invoices, or a saved reservation total exceeding linked
  invoice totals require Owner/Admin reconciliation. This does not automatically
  allocate historic payments, convert currency, waive debts or invent invoices.
- Legacy stays without invoices use reservation totals and actual payment records.
  Overpayments/refund-due amounts are displayed for Owner/Admin handling; they
  are not silently netted against a different invoice's unpaid amount.
- There is no on-account/agent-credit checkout exception in this version. Such a
  policy requires a separate approved workflow; Front Desk cannot waive a balance.
- This review covers recorded charges only. Unentered restaurant/laundry/minibar
  services cannot be detected automatically. Existing payment recording does not
  charge a bank card or send money through a gateway.

### Verification

- Backend suite: **229 tests passed** on 2026-10-27, including isolated HTTP tests
  for Front Desk assignment restrictions, cross-property/invalid-attendant
  rejection, checkout guard, stale previews and financial settlement edge cases.
- Frontend TypeScript passed. Isolated browser fixtures verified unpaid checkout
  blocking, invoice payment and successful checkout, housekeeping assignment,
  restricted cleaning/staff controls and responsive light/dark layouts.
- Read-only authenticated checks confirmed the supplied account has Front Desk
  access. Its property currently has zero physical rooms, active attendants and
  checked-in stays, so no real booking/payment/housekeeping data was changed.
- Test credentials/tokens were not saved in source or documentation. A production
  build and real-database concurrent billing acceptance were not run.

## Housekeeping requests and available attendants (2026-10-27)

The user clarified that "Manager" meant **Administrator**. No Manager or
Housekeeping login role was added in this change.

| Action | Owner / Administrator | Front Desk |
| --- | --- | --- |
| Create/update an attendant record | Yes | No |
| Request housekeeping for an eligible room | Yes | Yes |
| Directly assign an available attendant | Yes | Yes |
| Start/complete cleaning and inspect | Existing access retained | No |

Attendant creation/update is now explicitly Owner/Admin-only on the API as well
as in the interface. The legacy broad General member role cannot create/update
attendants or request/assign housekeeping through these guarded endpoints; its
other existing permissions were not changed.

### Workflow

1. Owner/Admin creates an active attendant using **Housekeeping Board > Assign > +**.
   This creates a property-scoped employee record, not a login account.
2. Front Desk has two choices on an eligible room:
   - **Request housekeeping**: enter priority/notes, then **Send request**. The room
     becomes Dirty with an unassigned Requested task. It appears in the **Requests**
     tab with requester/priority/notes, including after refresh.
   - **Assign**: select an available active attendant and confirm, without needing
     to create a request first. A pending request can also be assigned this way.
3. Assigning a request changes Requested to Assigned and removes it from the
   unassigned Requests queue. Every request and assignment is logged in Activity
   and the audit log; repeated pending requests for the same room are rejected.
4. Available means **active and not currently cleaning another room in this
   property**. Options show busy room(s) and the number of queued assignments.
   One attendant can have several queued rooms, but only one in progress.
5. Busy attendants cannot receive a new direct assignment or start a second room.
   Owner/Admin have no implicit bypass. Existing in-progress rooms cannot be
   reassigned until their current cleaning task is finished.

These operations use the same property inventory transaction guard. Assignment
and start recheck current worker availability inside it, not just a browser list.
Room action buttons are locked while a save/refresh is running; conflicting saves
refresh the board before showing the error. The latest refresh response wins,
preventing older responses from replacing a newer board state.

Requests/assignments currently apply only to active physical rooms which are not
occupied, out of order or under maintenance, matching the existing serviceability
rules. Assigning/requesting a clean room marks it Dirty because cleaning work is
now pending. This does not introduce occupied-room/stayover service workflows,
staff shift scheduling, automatic workload balancing or a Housekeeping-role
self-claim screen. The Requests queue is visible to existing authorized users;
it does not send a new bell/email/push notification. The notification types stay
the existing three for Front Desk. Cleaning-complete versus inspection readiness
rules were not changed in this step.

### Test checklist

- Front Desk can request a room, refresh, find it in Requests and assign a named
  available attendant. It cannot see the add-attendant **+** or create one via API.
- Owner and Administrator can create attendants and also request/assign rooms.
- Queue two rooms for one attendant while idle. Start the first as Owner/Admin.
  Starting the second must return a busy-attendant conflict, including concurrent
  start requests. Finish the first, then start the second successfully.
- While the attendant is busy, another unassigned room can be requested, but
  direct assignment to that busy attendant is blocked. Its option is disabled.
- Requests cannot erase an existing pending assignment or interrupt cleaning.
  Occupied/unavailable rooms and attendants from another property are rejected.
- Verification: **236 backend tests passed**, including isolated role/API and
  serialized-start simulations. Frontend TypeScript passed; browser fixture checks
  cover request persistence, availability display and role-specific controls.
  No hotel records were changed; real-database concurrency acceptance is still
  a manual check, and the dedicated Housekeeping role remains next work.

## Front Desk notification bell (2026-10-27)

Update 2026-10-30: Front Desk's three categories below are unchanged. Owner/Admin
now additionally receive two housekeeping categories, while Housekeeping has a
separate scoped request/assignment bell. See [housekeeping notifications](housekeeping-notifications.md).

Front Desk receives three of the nine existing notification categories:

| Category | Included |
| --- | --- |
| New booking | New active/non-deleted reservation records for the assigned property, including manually entered bookings |
| Invoice created | Reservation-linked guest/stay invoices, including company/agent-billed stays already viewable in the invoice workspace |
| Payment recorded | Posted guest invoice/reservation payments; voided/refunded payment records are excluded from this role's feed |

Credit notes, refund requests, withdrawals, purchases, expenses and financial
transactions are not included. Owner/Admin/general members retain their nine
existing categories. Viewing an alert does not grant any extra invoice, refund,
credit, settings or ledger permissions. Unknown roles have no notification feed.

The server chooses permitted source models and record filters from the verified
property role before fetching, limiting or counting notifications. Client query
parameters cannot expand that set. Mark-read verifies the notification exists
in the same property and belongs to an allowed type/status; forged and hidden
IDs return 404. Read state uses the verified signed-in account, not client identity
headers. Front Desk mark-all uses per-type read timestamps, leaving the other
six categories unread if the staff member later receives broader access. Existing
global read timestamps remain supported; no migration is required.

Invoice alerts open the permitted invoice workspace. New booking and unlinked
reservation-payment alerts open the permitted booking workspace, not Transactions.
Only the booking/invoice reference subpages were added to Front Desk navigation
permissions; other restricted pages remain blocked.

Same-page notification clicks explicitly reopen the current module. Invoice-created
and payment-posted alerts can share one invoice URL: clicking either now resets
the page filters/drawer state and fetches fresh records, even when the URL is
unchanged or the alert is already read. Switching to a different invoice retains
the existing reference-based navigation. Role restrictions and read state are unchanged.

### Use and test

1. Restart the backend to load the changes, then refresh the PMS while signed
   in as Front Desk. No role reassignment is needed. The header bell is visible.
2. Create a booking in the same property, or have Owner/Admin create it. Open
   the bell to refresh immediately, or wait up to 30 seconds. Its new-booking
   alert should appear; a confirmed stay may also generate an invoice alert.
3. Record a guest invoice payment. Its payment alert appears on the next refresh.
   Click booking/invoice alerts and confirm the correct workspace opens without
   an Access restricted error. Payment recording does not charge a real gateway.
4. Open one alert to mark it read, or choose Mark all read. Another user's unread
   state must not change. Front Desk must never see the six restricted categories,
   even when those records are newer than the permitted alerts.
5. Open an invoice-created alert, change its search filter, then click a payment
   alert for that same invoice. The invoice filter must reset and data reload.
   Repeat payment-to-invoice, the same payment twice, and a second invoice back
   to the first. Read and unread alerts must both navigate/reopen correctly.

These are the existing in-app record-creation alerts, not email, SMS or browser
push. Updating/cancelling a reservation, checking in/out or changing housekeeping
readiness does not yet create a separate notification event. No production OTA
connection is implied by enabling booking alerts.

Verification: backend suite **235 tests passed**, including JWT-authenticated
HTTP checks for type/status/property restrictions, identity spoofing, per-user
read actions and hidden unread preservation after role changes. Frontend types
passed; browser verification uses isolated API fixtures, without hotel data writes.
