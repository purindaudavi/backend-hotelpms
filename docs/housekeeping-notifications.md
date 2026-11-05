# Housekeeping notifications

Implemented 2026-10-30 (Asia/Colombo).

## Recipients

| Property role | New housekeeping alerts |
| --- | --- |
| Owner / Administrator | All saved requests, direct assignments and claims for this property |
| Housekeeping | Current unassigned requests, plus assignment/claim events for their linked active attendant |
| Front Desk | Existing booking, guest invoice and payment alerts remain unchanged |
| General member / Demo | Existing nine booking/financial categories remain unchanged |

Owner/Admin now have 11 notification types; Housekeeping has only the two new
housekeeping types. A valid login-to-attendant link is required for employee
alerts. Inactive attendants or revoked property access cannot read or mark them.
Assignment alerts for colleagues are excluded from an employee's bell. Existing
read-only Team assignments on the employee dashboard remain separate.

## What appears

- **Housekeeping requested · Room T101** — requested by the recorded acting
  account, with room type and time.
- **Room T101 assigned to Rashika** — assigned by the recorded acting account.
- **Housekeeping request claimed · Room T101** — identifies who accepted it;
  this uses the assignment notification type.

These are based on immutable `housekeeping_activities` events already saved in
the request/assignment/claim transaction. Polling does not create new alerts.
Reassignments have distinct activity IDs and read state. Existing saved events
can appear; missing historical events are not invented.

Owner/Admin retain historical request/assignment alerts. An employee's open
request alert disappears when that request is assigned/claimed. Tasks are reused
between cleaning cycles, so the request query also checks the current
`requested_at` timestamp, preventing a new request from resurfacing older cycles.
Employee assignment alerts remain historical events for their linked attendant;
current status and cleaning actions come from the refreshed work board.

The bell updates every 30 seconds while the browser tab is visible, when opened,
on becoming visible, or with its Refresh button. Background ticks pause in a
hidden tab and overlapping notification reads are skipped. This is in-app
polling; no browser push, email or SMS was added. The feed shows the latest 30
eligible records by default (API maximum 100), as before.

Clicking an Owner/Admin housekeeping alert opens the board with the room code
in its search filter. Employee request alerts open **Requests**, and assignment
alerts open **Assigned to me**. The board always loads current server state;
clicking a historical alert does not grant a claim, assignment or cleaning action.

## Read state and privacy

Property role and login identity come from authentication. Employee recipient
filters use the linked attendant resolved from the property and active attendant
record, never body/query/header claims. Filtering happens before activity sorting,
limiting and unread counting. Individual read actions use the same eligibility
rules, including the active-request condition.

Read state belongs to the property and login. Employee Mark all read records
only eligible event IDs (up to 100, with the existing 500-ID history bound).
It does not apply a blanket timestamp to hidden colleagues' assignments or
financial categories. Changing an attendant link does not retroactively mark
that attendant's previously hidden alerts read. Front Desk and general-member
read-all cutoffs remain category-scoped; Owner/Admin can mark their full feed.

## How to test

Use a disposable property, two linked active Housekeeping accounts, and separate
Owner/Admin/employee browser sessions.

1. Owner/Admin or Front Desk requests cleaning for a dirty, serviceable room.
   Open/refresh the bell: Owner/Admin and both employees see the new request.
2. Assign another room to employee A. Owner/Admin and A see its assignment.
   Employee B must not see A's assignment in their bell.
3. Click the request alert as B: Requests opens. Claim it. Owner/Admin receive
   the claim alert, B receives their assignment/claim alert, and that request
   leaves A's open-request notification feed after refreshing.
4. Mark all read as A. B's unread alerts and the Owner/Admin feed must stay
   unchanged. Click an assignment alert and verify Assigned to me opens.
5. Open a second property or deactivate the linked attendant: no cross-property
   alerts or unauthorized read actions should be possible. A normal employee
   still cannot open reservation/financial APIs through the bell.
6. Create a later cleaning request for the same room: it should have its own
   unread event rather than reusing the old alert/read state.

Verification: the 247-test backend suite passed, including scoped notification
API tests for forged recipient IDs, filtering before limits, request-cycle
reuse, claim removal, read isolation, link changes and inactive access. Frontend
TypeScript passed. `npm run smoke:housekeeping-notifications` passed 25 checks
against MongoDB using real request/assign/claim actions. Disposable accounts,
hotel, rooms, tasks, activities, read states, audits and guard were removed and
cleanup verified. Isolated desktop/mobile browser checks passed for Owner/Admin
and employee notification cards, hidden financial/colleague alerts, same-page
room filtering, request/assignment tab navigation and mobile layout. These UI
checks use simulated APIs separately from the real database acceptance check.
No real guest/property data was modified.
