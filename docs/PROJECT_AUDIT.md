# DMS PMS: project audit and completion plan

- **Saved:** 2026-10-16 (Asia/Colombo).
- **Basis:** The preceding read-only project audit in this conversation. Saving
  this report did not rerun the audit or implement its recommendations.
- **Purpose:** Preserve the project state, findings, verification limits, and
  recommended work order for the owner and future development sessions.
- **Overall assessment at audit:** Substantial real, database-backed PMS
  functionality exists, but the application is not ready to hand over as a
  finished monthly-subscription product. OTA integration is only one remaining
  part of the work.

## Financials 2 comparison view: 2026-11-05

An additional **Financials 2** sidebar entry now opens a unified comparison view:
All Activity, Bills / Invoices, Unpaid Bills and Summary. Original Financials
menus/screens remain available and their component file hashes were verified
unchanged. Both interfaces share the same live property records and existing
authorized APIs; actions are not simulated. Guest invoices reuse the original
detail/payment/credit/refund workflow; supplier/expense/withdrawal actions retain
existing server permissions, recipient validation and approvals. Front Desk,
Housekeeping and Demo are denied access to the new view.

Amounts are grouped by currency, and cash summaries exclude non-cash bills,
credits, drafts, pending requests, voids and known Night Audit inflow artifacts.
The original Profit & Loss report can be opened inside Summary with its existing
calculations. This UI does not fix historical accounting or OTA integration.
Optional pagination was added to read-only Purchase/Expense listing requests,
preserving legacy responses when no page is supplied. See
[comparison workflow, limitations and validation](financials2-comparison.md).

## Withdrawal recipients: 2026-11-04

New withdrawal requests/records now select an actual property Owner or
Administrator account, displaying name and role. The fixed ASIRI PERERA payee
was removed for new records. Finance's **Requested recipient** is separate from
the verified requester and Owner/Admin approver; pending requests remain without
financial effect and existing in-app notifications reach Owner/Admin/Finance.
Recipient identity is resolved server-side and eligibility is rechecked at
approval. Role/membership changes share the existing inventory transaction guard.
Historical completed payees remain unchanged; unlinked older pending requests
must be rejected and recreated, rather than guessed or silently reassigned.
The 257-test backend suite, 42 new live MongoDB checks, 40-check Finance
regression, frontend TypeScript and isolated desktop/mobile browser checks
passed. Disposable fixtures were removed. See [workflow and testing](withdrawal-recipients.md).

## Night Audit delegation and Finance review: 2026-10-30

Owner/Admin can grant a property-specific **Run Night Audit** checkbox to
existing Front Desk staff. Owner/Admin and delegated staff use the same detailed
screen; blocker overrides remain Owner/Admin-only. Finance uses that layout to
review completed days separately as Pending Review, Reviewed or Flagged, with
reviewer/time/notes and append-only review events. Finance cannot post, close,
override, reopen or edit closed operational data. General members' legacy broad
access no longer bypasses Night Audit permissions.

Audit completion advances the date independently of Finance review. Audit writes
and access changes share the property inventory transaction guard, recheck fresh
permissions and require the displayed audit ID; stale closes cannot close the
next day. Duplicate posting/report requests are serialized and stale Finance
reviews require a refresh. The 63-check disposable MongoDB acceptance test passed,
including Owner/Admin and delegated execution, concurrency, override boundaries,
review immutability and permission revocation/role reset. Existing accounting
calculations and unfinished real OTA reconciliation remain separate limitations.
The full 253-test backend suite, frontend TypeScript compilation and isolated
desktop/mobile browser checks also passed. Disposable test fixtures were removed.
See [implementation and test walkthrough](night-audit-delegation-review.md).

## Finance role: 2026-10-30

Finance is now assignable by property Owner/Admin. It has a per-currency finance
overview, financial modules except Integrations, a billing-only reservation
projection, eight financial reports/scoped history and Night Audit viewing with
independent Finance review (extended above).
An explicit API allowlist blocks operational changes, settings, channels,
posted-record voids, final credit/refund actions and day closing. Finance
withdrawals stay pending with zero financial effect until Owner/Admin approval;
approval/ledger/audit share the inventory guard and reject duplicate decisions.
Existing completed withdrawals and direct privileged recording are retained.
Staff revocation applies on the next request. The 250-test backend suite,
frontend TypeScript/browser checks and 40 MongoDB checks passed; disposable
fixtures were removed. No real staff or financial records were changed. Reports
role remains to implement; existing financial accounting/directory limitations
are not resolved by this role. See [setup, scope and tests](finance-role.md).

## Housekeeping request and assignment notifications: 2026-10-30

Owner/Admin notifications now include property-wide housekeeping request,
assignment and claim events. Housekeeping has a bell restricted to current open
requests and their linked active attendant's assignment/claim history. Role and
attendant checks precede queries/limits/read actions; request-cycle timestamps
prevent old requests resurfacing when tasks are reused. Read-all is personal
and preserves hidden recipients/types. Links open the relevant housekeeping
view; visible-tab polling is every 30 seconds with overlap protection. Front
Desk's three existing types and general-member/demo's nine types are unchanged.
The 247-test backend suite, frontend TypeScript/browser checks and 25 MongoDB checks passed;
disposable fixtures were removed and cleanup verified. See
[usage, recipient scope and acceptance tests](housekeeping-notifications.md).

## Owner/Admin property deletion requests: 2026-10-29

Your properties now has a small delete icon for Owner/Admin that opens a
deletion request form. Submission leaves the property active and supplies a
shared PDR code. Requesters can track/cancel their pending request; the protected
platform portal has a Deletion requests tab for approval/rejection. Approval
archives with Restore and preserves hotel records/staff memberships. It rechecks
current requester authority/ownership and uses the shared property guard,
optimistic versions, typed name confirmation and transactional actor audits.
Duplicate pending requests and repeated/racing decisions are blocked. Rename
remains directly available in Owner/Admin Settings and the platform portal.
All 246 backend tests, frontend typecheck/browser flows and 65 MongoDB smoke
checks passed with disposable fixture cleanup. No real property was archived.
See [workflow, limits and acceptance tests](property-deletion-requests.md).

## Platform property management: 2026-10-28

The protected PMS owner portal now lists property metadata across all accounts
and supports Rename, Archive and Restore. Rename preserves permanent IDs and
linked records. Archive denies property access and retains data/memberships;
Restore reopens the same hotel. Archived hotels still consume the owner's
approved allowance. Reasons, typed archive/restore confirmations, optimistic
versions and actor audit records protect changes. Archive also locks the shared
inventory guard to stop guarded saves after archiving. No real property was
renamed or archived during implementation. All 244 backend tests, frontend
typecheck and 43 MongoDB smoke checks passed with disposable fixture cleanup.
Cached names and preexisting fixed email branding can require refresh/manual
template correction. Hotel-owner rename/archive request approvals are a later
stage; the existing settings name editor is unchanged. See
[workflow, limitations and tests](property-creation-approval.md#platform-property-management-2026-10-28).

## Property creation approval: 2026-10-28

Unauthorised account-level property creation is now blocked. A new requester
page and protected PMS owner portal share random reference codes, contact/
business details and approved total property limits. Zero is the default quota;
hotel Owner/Admin roles do not authorize creation or platform review. Approvals
and creation serialize on the account document, preventing concurrent final-slot
overruns. Existing hotel access is retained. The explicitly nominated platform
account is provisioned separately from hotel roles. All 242 backend tests,
frontend typecheck/browser flows and 26 MongoDB-backed approval checks passed,
with disposable fixture cleanup verified. This is manual platform authorization,
not subscription billing. See [workflow, provisioning and tests](property-creation-approval.md).

## Housekeeping action attribution: 2026-10-28

UX follow-up: Activity and room history now group each cleaning job into one
card with Requested by, Assigned by, Started by and Completed by visible
together; claim/inspection rows appear when recorded. Full activity expands to
the individual events. Filters retain the full matching job context. Grouping
uses room identity and workflow boundaries rather than reused task IDs, and
missing historical steps are not inferred. Six frontend grouping tests,
TypeScript and isolated desktop/mobile browser checks passed.

The shared Activity timeline and per-room history now separate the acting
account from the assigned attendant. Request/assign/claim/start/complete/inspect
entries show the recorded name, role and timestamp, with extra notes/status
changes under Details. New self-claims persist claimed events and action role
snapshots come from authenticated property access. Historical missing roles and
old claims recorded as assigned are not inferred or rewritten. Full backend
suite (240 tests), frontend typecheck and isolated browser checks passed. See
[attribution behavior and acceptance tests](housekeeping-role.md#activity-who-performed-each-action-2026-10-28).

## Housekeeping automatic updates: 2026-10-28

Owner/Admin and Front Desk Board/Information now poll visible screens every 30
seconds; Information includes reservations as well as housekeeping records.
The employee Dashboard/Board uses the same hidden-tab, single-read and save
coordination safeguards. Open forms/filters persist, stale route reads abort,
and temporary background errors retain displayed data with a warning. Duplicate
app-shell bootstrap reads are skipped on housekeeping routes. Frontend typecheck
and isolated browser polling/visibility/save/error checks passed; live acceptance
remains local. Today/business-date behavior is unchanged. See
[automatic updates and tests](housekeeping-role.md#automatic-updates-2026-10-28).

## Housekeeping dashboard update: 2026-10-28

Owner/Admin and Front Desk can now read cleaning completion notes in the board's
Activity tab and per-room history in the Assign drawer. The frontend maps notes
from the cleaning-completed activity snapshot, preserves line breaks and hides
blank/legacy notes; the backend already saved and returned these notes. Personal
Housekeeping history and team-view privacy remain unchanged.

Dashboard now has a separate overview of pending requests, personal assigned/
active work and read-only Team assignments showing who is handling other rooms.
The team API projection is property-scoped and omits other employees' notes and
contacts; existing own-task mutation restrictions still apply. The Housekeeping
Board retains the cleaning controls and personal history. Data refreshes every
30 seconds or manually. The shared list covers up to 100 current assignments,
not historical acceptance/completion records. See [usage and testing](housekeeping-role.md).

## Housekeeping role update: 2026-10-27

Housekeeping is now a property-scoped login role linked to one active attendant.
Its personal dashboard shows unassigned requests, own assignments, active work
and immutable completion history. Employees can claim/start/complete their own
tasks; other departments' data and inspection/assignment administration remain
blocked on the backend and frontend. One cleaning job per attendant is enforced
within the existing transaction guard. Owner/Admin can grant and edit the login
link. All 240 backend tests and frontend TypeScript checks passed; automated API
tests use isolated model fixtures, and live database acceptance remains a manual
check. See [setup, limits and testing](housekeeping-role.md).

## Housekeeping request and assignment update: 2026-10-27 (preceding stage)

The user clarified "Manager" means Administrator. Owner/Admin can create
attendants; Owner/Admin/Front Desk can request housekeeping and directly assign
available active attendants. A persisted unassigned Requests queue records
priority, notes and requester. Busy checks prevent one attendant cleaning two
rooms at once, while several queued assignments remain allowed. These checks
run within the property transaction guard. Duplicate UI actions are locked and
conflicts refresh the board. No Manager/Housekeeping login role, self-claim UI,
occupied-room service workflow or new notification category was introduced.
See [workflow and tests](front-desk-role.md#housekeeping-requests-and-available-attendants-2026-10-27).

## Front Desk notification update: 2026-10-27

Front Desk now has the notification bell for new bookings, reservation-linked
invoices and posted guest payments. Server-side filtering precedes pagination
and unread counts; hidden financial sources are not queried for Front Desk.
Read state is account/property scoped and Front Desk mark-all does not consume
the six hidden categories. Booking/invoice notification reference links remain
within permitted workspaces. Same-invoice invoice/payment alerts explicitly
reopen and reload the active module rather than relying on a no-op same-URL
router push. Other notification categories and lifecycle/
housekeeping event alerts have not been added. See [notification usage and tests](front-desk-role.md#front-desk-notification-bell-2026-10-27).

## Front Desk housekeeping and checkout update: 2026-10-27

Front Desk can assign existing active housekeeping attendants without creating
staff or completing cleaning/inspection. Checkout now has a recorded-charge
review and a server-side settlement guard for all roles. Guest invoice payments
are available from the review. Invoice/credit/refund writes share the inventory
transaction guard to serialize billing changes with checkout. Legacy financial
reconciliation, unrecorded services and on-account checkout policies are not
automatically resolved by this change. See [usage, safety and verification](front-desk-role.md#housekeeping-assignment-and-checkout-review-2026-10-27).

## Front Desk role update: 2026-10-23

A property-scoped Front Desk role now has backend API restrictions, filtered
navigation, blocked direct links, operational overview/read-only reference
pages and limited invoice payment actions. Booking saves validate Front Desk
prices against server quotes and protect paid totals, approved overrides and
agent terms. Restricted financial, settings, channel and Night Audit operations
remain blocked. Existing unrestricted roles retain their previous access.
See [Front Desk permissions and acceptance tests](front-desk-role.md).

At this stage Manager, Housekeeping, Finance and Reports remained pending;
Housekeeping is superseded by the update above. The older
pricing-enforcement audit finding is not marked fixed for unrestricted roles.

## Owner/Admin access foundation update: 2026-10-23

Existing property owners retain access. Owners can now appoint property-scoped
administrators; administrators manage operations and general member access.
Only owners manage administrator appointments/removal and plan/trial metadata.
Staff grants, role changes and revocations are transactional and audited.
The frontend Access panel and property role labels use backend roles and
permissions. Public registration cannot self-assign property privileges.
Signup now collects name, email, password and mobile only; employee numbers
are optional in the account model and existing values are preserved. New
accounts start without property access and create or join a property afterward.

General members retain their broad existing operational access. The five
department roles, employee/login linkage, subscription billing and property
limits remain unfinished. See [Owner/Admin access and testing](owner-admin-access.md).
The findings below remain a historical baseline unless explicitly superseded.

## Occupied/future-booked room safeguards update: 2026-10-16

Room catalog mutations now reject unsafe occupied-room transitions, manual
Occupied creation, future-assignment disruption and capacity reductions that
strand unassigned reservations or active group holds. Hard deletion/renaming
protects reservation/move, housekeeping, cross-booking and rate references.
The force-delete bypass is removed; owner/admin callers have no safety bypass.
Reservation statuses and detailed staff-role permissions are unchanged. See
[the room status safeguards and test guide](room-status-safeguards.md).
All 206 backend tests, 16 database-backed room-safety scenarios and the existing
38-scenario concurrency/day-use/move suite passed, with fixture cleanup verified.
Browser testing and dated maintenance windows remain.

## In-house room-move update: 2026-10-16

Same-room-type moves now have a dedicated PMS action and database-backed atomic
workflow: reservation assignment, old/new room states, cleaning task/activity,
historical allocation dates and staff audit history. Availability and Front Desk
grid checks respect the effective move date, and normal edits cannot bypass the
workflow. Rates/payments remain unchanged. See
[the implementation and test guide](in-house-room-moves.md). All 184 backend
tests, frontend typecheck, 15 isolated MongoDB move scenarios and the combined
38-scenario concurrency/day-use/move suite passed, with fixture cleanup verified.
Room-type upgrades and other consumers' historical
allocation reporting remain separate work. Interactive browser testing remains.

## Day-use availability update: 2026-10-16

The backend now counts zero-night day-use stays on their arrival date in
room-type, physical-room, group-hold and cross-booking availability checks.
Saved dates, zero overnight nights and charges are preserved; day-use check-in
also requires the correct business date. See
[day-use implementation and testing](day-use-inventory.md). All 174 backend
tests and ten database-backed day-use scenarios passed with fixture cleanup
verified. Browser/local inventory-display unification remains separate work.

## Simultaneous-booking update: 2026-10-16

Database-backed property guard transactions now coordinate reservation writes,
business block activation/pickup, the test-channel importer, room catalog and
cross-booking changes, and housekeeping readiness mutations. See
[simultaneous booking protection and testing](simultaneous-booking-protection.md)
for implementation details, verification, deployment requirements and limits.
The shared guard replaces the earlier read-then-save race; it does not implement
real OTA connectivity. Day-use date-query handling was subsequently corrected
in the update above.

## Per-night update after the audit snapshot: 2026-10-16

The backend multi-night reservation/group-hold capacity calculation has now been
corrected to check each stay night separately. See
[the fix and test guide](per-night-inventory.md) for scope and manual test steps.
All 134 backend tests and seven database-backed service smoke checks passed;
temporary database fixtures were removed and cleanup verified. Browser testing
has not been performed. Frontend inventory unification remains separate work;
concurrency and day-use boundaries are addressed in the updates above. The
original findings and checklist below are retained as the historical baseline.

## Project locations and product context

| Project | Location / purpose |
| --- | --- |
| PMS backend | `D:\DMS new\hotelbackend` |
| PMS frontend | `D:\DMS new\new-pms` |
| Separate development provider | `D:\DMS new\dms-test-channel` |
| PMS landing-page project | `D:\DMS new\staypilot landing page` |
| Promotional-video project | `D:\DMS new\dms-promo-video` |
| Product name | Destination Management System (DMS) |
| Company website | `https://dms.lk` — company website, not a published PMS login |
| Cabana business reference | `https://www.designmyshade.lk` |

The intended business is to provide hotels with their own PMS workspace for one
or more properties, eventually on a monthly subscription. The PMS frontend was
still unpublished according to the user's latest clarification. Do not confuse
the sales website, promotional animations, local preview data, development
provider, and actual operational PMS integrations.

## Audit scope and verification

The audit reviewed frontend and backend source, database models, the development
test channel, and relevant landing-page flows. No source fixes, live booking
creation, financial posting, or MongoDB data changes were performed by the audit.
The worktrees already contained user changes; those were preserved.

| Check | Result at audit |
| --- | --- |
| Backend syntax: `npm run check` | Passed |
| Frontend: `npm run typecheck -- --incremental false` | Passed |
| Backend automated tests | 109 passed; 0 failed |
| Separate test-channel isolated tests | 5 passed; 0 failed |
| Multi-night availability diagnostic using mocked models | Reproduced false unavailability; no live database used |
| Actual MongoDB booking-to-checkout workflow | Not verified; `http://127.0.0.1:3500/api/health` was unavailable |
| Production frontend build and deployed-browser acceptance | Not verified by this audit |
| Dependency audit: backend, `--omit=dev` | 10 findings: 2 critical, 6 high, 2 moderate |
| Dependency audit: frontend, `--omit=dev` | 7 findings: 1 critical, 6 high |

The successful backend test run used the files returned by
`rg --files test -g '*.test.js'`, passed as arguments to
`node --test --test-reporter=spec`. Most existing tests validate models, helpers,
and mocked routes. They do not prove real MongoDB concurrency, deployment
security, or every complete hotel workflow.

Dependency findings are the prior scan's package-level results, not a count of
independent proven application exploits. Recheck installed versions, advisory
applicability, and scan results when doing the upgrade work.

## Module-by-module status

"Implemented" below means actual code/database functionality is present. It
does not mean the module has passed production acceptance or has no defects.

| Area | Implemented | Still required |
| --- | --- | --- |
| Registration and login | Registration, bcrypt password hashing, login, JWT access/refresh sessions, logout, password change. | Forgotten-password recovery, throttling, stronger backend validation, improved session revocation and token uniqueness. |
| Multiple properties | Property creation/listing/switching, ownership, member access, server-side property separation. | Comprehensive isolation testing and subscription-based limits. |
| Staff roles and employees | Owner/member access exists. | The six displayed staff roles are not module permissions; employee settings are browser-local and not linked to login identities. |
| Room types and physical rooms | MongoDB CRUD, capacity, occupancy supplements, images, operational and housekeeping statuses. | Backend guards for occupied/future-booked rooms and safe deletion/disable/history handling. |
| Rates and meal allocation | Persistent rate plans, room-type prices, daily overrides, restrictions, meal allocation snapshots and invoice breakdowns. | Enforce quote/restriction validation during reservation saves; preserve historical snapshots on edits. |
| Rooms & Rates inventory | Calculated availability and persistent daily price/bulk price changes. | Correct and unify availability; wire rules/settings/logs controls to actual backend workflows. |
| Reservations and Front Desk | Persistent reservations, assignment, check-in/out, cancellation/no-show, occupants, attachments, guest synchronization, audit and invoice automation. | Concurrent-booking protection, day-use overlap handling, atomic in-house room moves and authoritative financial totals. |
| Business blocks, events, cross-booking | Persistent allocations/holds/pickup, group records, venue events and room-pair links. | Concurrency protection and reconciliation when dates, allocations or linked rooms change. |
| Housekeeping | Persistent attendants/tasks, assignment, cleaning, inspection and activity history. | Stayover cleaning of occupied rooms; clearer task reset after checkout. |
| Guest profiles | Persistent CRUD/search, property/email matching and reservation booker synchronization. | Validate walk-in/contact requirements and expand guest history only if required; passport scanning is not established by this module. |
| Travel agents | Persistent records, reservation links, booking/room-night/revenue/commission performance and audit. | Validate active same-property agent references and negotiated terms on reservation saves. Finance's separate agent form remains local. |
| Invoices, credits, refunds | Persistent documents, numbering, balances, payment recording, correction workflows and transaction history. | Reconcile financial pathways/currencies and integrate actual money movement if needed. Recorded payments/refunds do not themselves transfer funds. |
| Purchases, expenses, withdrawals | Persistent records and associated transactions. | Shared suppliers, permissions, pagination and accounting review. |
| Payables and receivables | Purchase balances, invoice balances and payment recording. | Supplier/agent creation in these screens is not fully backend/shared. |
| Night Audit | Reviews/exceptions, room-revenue posting, report pack/history, business-date advancement. | Correct daily/currency monetary calculations and posting classification; live channel reconciliation. |
| Dashboard | MongoDB-backed Overview/Analytics/Travel Agents plus explicit demo mode. | Align meanings/calculations across dashboards and improve capacity/date consistency. |
| Reports | 14 report types available, generation history and CSV. | Trial Balance, Reports > Profit & Loss and Invoice Daybook are disabled. |
| Channel connection requests | Owner intake, cancellation/reply, internal review, status/history and optional SMTP notification. | Secure credentials, provider tests, actual verified connection activation. |
| Channel Manager | Database-backed imported bookings listing/detail/history. Several configuration/inventory/sync/log/message screens are browser-local previews. | Real OTA connectors, mappings, booking changes/cancellations, availability/rate/restriction delivery, retries, durable logs and reconciliation. |
| DMS Test Channel | Real authenticated development loopback connection, manual room/rate snapshot, synthetic reservation import and duplicate handling. | Date-specific availability, automatic outbound updates, durable provider state, broader revision handling; intentionally test-only. |
| IBE / hotel website booking | Browser-local configuration and visual preview. | Public search, authoritative quote/availability, reservation creation, payment, confirmation and customer self-service. |
| Property settings | Property information, official images/theme and meal allocations persist centrally. | Taxes, exchange rates, gateways and hotel-feature settings remain partly local/simulated. |
| Email | SMTP code and MongoDB-backed custom templates/activation. | Dynamic default property branding/currency, live delivery validation and reliable retries. |
| Data import | Template download and CSV row preview. | Actual validated/staged import, duplicates, results and proper spreadsheet support. |
| Settings activity logs | Sample activity display/export. | Genuine audit data and working actions. Other modules do have real backend audit records. |
| Rate Hunter | Benchmark/search UI using labelled sample hotels. | Actual competitor-rate provider if this feature is to be offered live. |
| Monthly SaaS subscriptions | Property plan/trial metadata. | Recurring billing, entitlements, trial expiry, limits, payment failures, suspension/reactivation and billing administration. |
| Landing-page enquiries | Sales presentation and local demo-request form. | Server-side lead delivery/notification or a real contact route; the form currently stores its submission locally. |

## Priority findings

### 1. Incorrect multi-night availability calculation — high priority

The backend selects every reservation overlapping the requested range and sums
its rooms across the whole range, rather than testing capacity per stay date.

Reproduced offline example:

- Two sellable rooms.
- Existing booking A: October 1–2, one room.
- Existing booking B: October 2–3, one room.
- Proposed booking C: October 1–3, one room.
- There is one room free each night, but the backend reports zero availability.

Evidence: `services/booking-availability.service.js`, around lines 96–162.
The inventory UI uses different per-date calculations, producing grid/save
disagreement. Implement one authoritative per-date availability service covering
reservations, blocks, cross-booking, day use and operational exclusions.

### 2. Concurrent booking and pickup protection — high priority

Transactions exist, but inventory checks read shared availability and then insert
separate reservations. No shared room/type/date stock claim or lock was found to
serialize competing bookings. Two requests can both see the final room as free.
Different guest and reservation documents do not inherently conflict.

Business-block pickup and venue-event creation need equivalent concurrency
protection. Source-level risk was identified; a live MongoDB race reproduction
was not performed.

Evidence: `services/booking-availability.service.js`; reservation creation and
pickup in `routes/bookings.js` around lines 137 and 1153–1237.

### 3. In-house room moves and room integrity — high priority

Reservation PATCH accepts checked-in records and saves replacement rooms without
atomically releasing the old physical room and occupying the new one. The
frontend locally adjusts room states, which can hide the persistent mismatch.
Checkout can then release the new room while leaving the old room occupied.

Add a dedicated transactional move operation, validating destination readiness
and marking the vacated room appropriately. Backend room PATCH also permits
status changes not allowed by the UI; deleting/disabling future-referenced rooms
needs reference guards or archiving.

Evidence:

- `routes/bookings.js` around lines 295–359.
- Frontend `app/components/modules/front-desk/use-reservation-actions.ts` around line 198.
- `routes/rooms.js` around lines 145–208.

### 4. Day-use and quote enforcement — high priority

Day-use reservations may store equal check-in/check-out dates, while the ordinary
overlap query uses an exclusive end. They can consequently disappear from the
backend overlap check even though the frontend treats them as using the room.

The quote service itself supports active plans, validity, daily prices,
occupancy supplements, stop-sell, arrival/departure restrictions and min/max
stays. However, manual reservation POST/PATCH does not consistently invoke that
contract. Client-supplied prices/financial summaries and complimentary flags
need server validation and authorised override handling.

Evidence: `services/booking-availability.service.js` around line 403;
`services/rate-quote.service.js`; `routes/bookings.js` around lines 137–162 and
299–327; frontend `app/lib/bookings-api.ts` around lines 539–587.

### 5. Staff roles and shared employee identities — high priority

Registration displays Owner/Administrator, Manager, Front Desk, Housekeeping,
Finance and Reports. These are not enforced operational permissions. Public
registrations become `user`, while property access currently distinguishes
owner/member. Public registration does not grant global admin privileges.

Implement per-property membership roles, backend permissions, matching sidebar
and action visibility, and staff invitation/account linkage. Settings Employees
and real housekeeping attendants are separate records, not login identities.

Evidence: `routes/auth.js` around line 32;
`services/property-access.service.js` around lines 9–14;
frontend `app/components/modules/settings/employee.tsx` around line 10.

### 6. Authentication completion and session reliability

- Forgotten-password recovery is absent; authenticated password change exists.
- No login/register throttling, backend minimum-password policy or verified
  onboarding flow was identified.
- Refresh tokens contain user ID and second-resolution issue time without a
  random identifier. Two logins for the same user in the same second can produce
  the same token/hash and conflict with the unique session index. Identical-token
  behaviour was checked with an isolated fake-key diagnostic; the database 500
  was not reproduced live.
- Logout/password change removes refresh sessions, but existing access JWTs can
  remain valid until their one-hour expiry.
- Remember-me remembers email; tokens persist in localStorage independently.

Evidence: `routes/auth.js` around lines 58–69, 114, 137–158;
`db_models/session.model.js` around line 10;
`services/property-access.service.js` around line 31;
frontend `app/login/page.tsx` and `app/lib/current-user.ts`.

### 7. Financial consistency and currency handling — high priority

- Profit & Loss sums different currency amounts and formats the result as LKR.
- Reservation payment creation accepts a currency different from the reservation;
  paid-total recalculation adds raw amounts without conversion or filtering.
- Reservation edits accept a client financial summary, including paid totals;
  establish one authoritative payment/document calculation path.
- Night Audit sums monetary values across currencies and posts room revenue with
  direction `in`, shown as Money In, although it is not a collected payment.
- Night Audit uses stored effective room rates rather than a preserved
  date-specific nightly breakdown. Review nightly recognition for variable prices.
- Financials > Profit & Loss exists separately from the disabled Reports >
  Profit & Loss endpoint. This is not full general-ledger/accounting integration.

Evidence:

- Frontend `app/components/modules/financials/profit&loss.tsx` around lines 418–485.
- `routes/bookings.js` around lines 631–652 and 1511–1524.
- Frontend `app/lib/bookings-api.ts` around lines 584–587.
- `routes/night-audit.js` around lines 95–118.
- `services/night-audit.service.js` around lines 62–90 and 293–298.

### 8. Operational configuration is partly local or simulated

- Gateway secret fields persist in browser localStorage; gateway connection UI
  is not actual payment onboarding. Use server-managed credentials before real use.
- Currency refresh randomly adjusts displayed exchange rates even when labelled
  live. Use explicitly approved manual rates or a real, persisted provider feed.
- Local tax settings do not yet drive authoritative reservation/invoice taxation.
- Financial supplier creation and Finance's separate agent creation only update
  local state, unlike the real Reservation > Travel Agents module.
- Rooms & Rates Inventory rule/settings drawers have save buttons that only
  close them, plus fixed sample log entries.
- Channel Manager inventory uses a separate local store rather than the
  authoritative room/rate inventory.

Evidence: frontend `app/components/modules/settings/property/property-page.tsx`
around lines 64–74; `paymentagateway.tsx` around lines 20–26; `currency.tsx`
around line 17; `taxes.tsx` around line 40;
`app/components/modules/financials/financials-page.tsx` around lines 289–296,
840–843 and 1000–1003; inventory-page.tsx around lines 398–430.

### 9. Default multi-property customer emails are incorrect

Default template mode returns legacy fallback HTML containing Ronaka branding,
contact details and LKR assumptions. Correct supplied property variables are
used by custom templates, but do not repair the default fallback. Checkout can
also prepend LKR to a value that already includes another currency label.

Render the built-in defaults using the selected property's variables and verify
delivery. SMTP settings were present, but no email was sent during the audit.
The optional channel-review notification recipient was not configured.

Evidence: `services/email-template.service.js` around lines 73–75;
`routes/mail.js` around lines 340, 366, 377, 437, 493, 497, 568 and 628;
frontend `app/lib/reservation-email.ts` around lines 135 and 177.

### 10. Dependency upgrades and production hardening

The prior production-dependency scans reported backend 2 critical / 6 high /
2 moderate and frontend 1 critical / 6 high. Installed Next.js was 15.5.19,
Express 5.2.1, Axios 1.18.1 and Nodemailer 9.0.3 at inspection.

For example, the official Next.js Windows-hosting advisory identifies affected
versions including the inspected version:
[GHSA-p293-qw3h-jr36](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36).
Other reviewed sources include the
[proxy-addr advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
and [Nodemailer advisory](https://github.com/nodemailer/nodemailer/security/advisories/GHSA-v53p-9fqp-m79j).

Upgrade to supported patched versions, check application-specific applicability,
rerun audits and regression tests, and verify the deployed configuration.
Do not assume every transitive advisory is a demonstrated exploit of this PMS.

The OTA simulator can be explicitly enabled in production by its feature flag;
add a hard production prohibition matching the separate test-channel bridge.
Deployment, backups/restoration, monitoring, retention and production acceptance
still require verification; their completion was not established by this audit.

## Channel Manager: exact integration boundary

The user explicitly confirmed that live OTA APIs are not integrated. Preserve
that distinction in documentation, demos and promotional claims.

### Already implemented

- Persisted owner connection requests and restricted internal review/history.
- Database-backed listing/detail/audit of imported channel reservations.
- A separate development provider using authenticated loopback HTTP.
- Manual room/rate snapshot and test-ID mapping.
- Synthetic booking import, duplicate protection, notes-only modification and
  cancellation paths through development services.

### Still required for live provider operation

1. Official provider/sandbox access and a server connection entity.
2. Secure credentials, endpoint controls, connection testing and actual status.
3. Fetched/persisted provider property, room-type and rate-plan mappings.
4. Booking/create/change/cancel ingestion, validated authenticity, durable event
   storage, idempotency, revision ordering and acknowledgements.
5. One authoritative per-date availability/rate/restriction source.
6. Durable outbound updates after bookings, edits, cancellations, rates and room
   operational changes; retries, backoff and partial-failure handling.
7. Reconciliation/backfill, redacted provider logs, health and alerting.
8. Provider sandbox end-to-end/concurrency testing and a monitored pilot.

The development provider keeps snapshots in memory, needs manual sync and an
updated access token, and does not implement date-specific availability or
automatic outbound rate changes. Older provider room codes/configuration rows
are illustrative browser-local records. The test provider does not establish
that Booking.com, Expedia, Agoda or Airbnb are connected.

Useful existing references:

- [Test channel boundary](test-channel-connection.md)
- [Connection-request workflow](channel-connection-requests.md)
- [Multi-property access](multi-property.md)
- [Night Audit API](night-audit-api.md)
- [Rates API](rates-api.md)
- [Rooms API](rooms-api.md)
- [Financial document API](invoices-credits-api.md)

## Recommended completion sequence

### Phase 1: Reliable hotel operations

- [ ] Correct per-night inventory calculation and use one shared engine.
- [ ] Protect simultaneous last-room bookings, block pickup and venue events.
- [ ] Correct same-day/day-use overlaps.
- [ ] Implement atomic in-house room moves with room/housekeeping reconciliation.
- [ ] Guard room edits, deletion and disabling against active/future references.
- [ ] Enforce rate quotes/restrictions and authorised price/complimentary overrides.
- [ ] Preserve historical meal allocation/pricing snapshots when editing.

### Phase 2: Accounts and permissions

- [ ] Implement per-property staff roles and backend permissions.
- [ ] Connect persistent employee records to memberships/login identities.
- [ ] Implement password recovery and account abuse protections.
- [ ] Add refresh-token uniqueness/rotation and appropriate session revocation.
- [ ] Test cross-property isolation for every entity, file and operation.

### Phase 3: Financial accuracy

- [ ] Make totals and payment/document state server-authoritative.
- [ ] Separate currencies or use explicit approved conversion snapshots.
- [ ] Reconcile reservation payments, invoice payments, credits and refunds.
- [ ] Correct Night Audit date-specific recognition and cash/non-cash semantics.
- [ ] Align dashboard, P&L and report definitions.
- [ ] Complete or clearly disable unavailable accounting reports.

### Phase 4: Persistent operational settings

- [ ] Persist suppliers and Finance's agent records through shared backend models.
- [ ] Persist and apply taxes, currencies, inventory rules and relevant features.
- [ ] Remove real secrets from browser-local configuration.
- [ ] Replace fake settings activity logs and simulated live FX refresh.
- [ ] Complete import processing or label the UI as a preview.
- [ ] Correct default email property/currency information and verify delivery.

### Phase 5: One real channel connector

- [ ] Complete the live-integration checklist above for one provider.
- [ ] Validate changes/cancellation, duplicate delivery, retries and reconciliation.
- [ ] Pilot one property before broad provider rollout.

### Phase 6: Direct bookings and customer subscriptions

- [ ] Build the public IBE search/quote/reservation/customer workflow.
- [ ] Integrate actual guest payments and verified webhooks if offered.
- [ ] Implement monthly subscription billing, trials, entitlements and plan limits.
- [ ] Handle payment failure, cancellation, suspension and reactivation.
- [ ] Deliver landing-page enquiries to the business rather than local storage.

### Phase 7: Deployment and monitored acceptance

- [ ] Resolve relevant dependency advisories and rerun checks.
- [ ] Verify production build, environment, HTTPS and simulator/demo restrictions.
- [ ] Configure monitoring, operational alerts and backup/restoration procedures.
- [ ] Run the complete MongoDB hotel workflow and concurrent-booking tests.
- [ ] Validate mobile/desktop usability and multi-user refresh consistency.
- [ ] Release a monitored pilot before paid general rollout.

## Acceptance scenarios still needed

1. New account -> create property -> add staff with genuinely different roles.
2. Room type/physical rooms -> rate plan/meal allocation -> book -> invoice.
3. Payment -> check-in -> in-house room move -> reload -> checkout.
4. Checkout -> assign housekeeping -> clean/inspect -> next guest check-in.
5. Multi-night bookings with staggered existing stays and exact daily capacity.
6. Two simultaneous last-room bookings and competing block pickups.
7. Same-day/day-use reservation conflicts.
8. Maintenance/out-of-order rooms and attempted future-referenced deletion.
9. Cross-booked rooms with unassigned room-type reservations.
10. Bypassed frontend rate restrictions and authorised/unauthorised overrides.
11. Editing after meal-allocation changes without corrupting historical values.
12. Partial/full payments, credits, refunds and voids with consistent balances.
13. Different currencies and nightly prices through invoices/reports/Night Audit.
14. Night Audit exceptions -> report pack -> close -> next business date.
15. Two separate hotel owners attempting each other's data and files.
16. OTA import/revision/cancellation -> outbound updates -> failure/retry/reconcile.
17. Backup restoration and recovery of a usable property workspace.

## Notes for future sessions

- **2026-11-12: Night Audit V2 replaces the checklist workflow.** User chose Run
  now only, with no automatic no-show decisions. One guarded transaction checks
  blockers, records existing invoice allocations without a second revenue/cash
  posting, saves six frozen reports and advances one business day. Manual receipt
  verification uses local-date payment records; Owner/Admin alone overrides
  eligible exceptions. Owner/Admin now verifies completed days as well as Finance.
  Existing closed history remains. This does not migrate the whole PMS to an
  accrual ledger or fix historical closed-day postings. See
  [workflow, accounting boundaries and tests](NIGHT_AUDIT_V2.md).

- **2026-11-12: Live Activity Logs.** Settings Activity Logs now reads existing
  property audit events with Owner/Admin-only access, hotel-local dates,
  pagination, actor/change details, visible-tab refresh and scoped CSV export.
  The old static sample page has been replaced. This exposes existing recorded
  events; it does not add logging to every operation or reconstruct missing
  history. See [coverage, permissions and testing](ACTIVITY_LOGS.md).

- 2026-11-06: [Staff money requests and opening funds](MONEY_REQUESTS.md) now
  documents the four-role request → Owner approve → actual Paid flow, scoped
  receipts/notifications, advances/returned change, and Owner-only one-time
  opening balances. Verified with 275 backend tests, 69 real MongoDB/API checks,
  frontend TypeScript and browser walkthroughs. This does not repair the separate
  historical Night Audit revenue/tax issues or provide bank synchronization.

- Treat this as a historical audit baseline. Verify current code before treating
  any item as still open, fixed, or fully working.
- File/line references identify the audited snapshot and may move after edits.
- Preserve existing user changes; this audit was performed on dirty worktrees.
- Prefer targeted regression coverage for the findings over repeatedly rerunning
  unchanged broad smoke tests.
- Live smoke scripts can create records or financial effects. Use a disposable
  test property and appropriate authority before running them.
- Do not equate a visible control, localStorage update, preview animation or
  passing model test with a complete live hotel workflow.
- Record fixes and verification here or in a linked dated follow-up; do not mark
  an item complete based on appearance alone.

## Change history

| Date | Change |
| --- | --- |
| 2026-10-16 | Saved the preceding read-only project audit, detailed findings, verification limits and completion plan. No implementation fixes included. |
