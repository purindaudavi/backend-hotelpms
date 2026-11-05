# Housekeeping property role

Implemented 2026-10-27 (Asia/Colombo). This extends the existing request and
assignment workflow; Administrator is the existing admin role, not a new Manager.

## Employee workspace

Housekeeping has only Dashboard and Housekeeping Board in the sidebar. Updated
2026-10-28: Dashboard is now a separate overview with pending requests (including
Claim request), own assigned/in-progress work, personal summary counts, and
read-only Team assignments. Open my work links to the Housekeeping Board for
cleaning controls and completion history. The board retains these sections:

| Section | What appears | Employee action |
| --- | --- | --- |
| Requests | Serviceable, unassigned housekeeping requests for this property | Claim for themselves |
| Assigned to me | Rooms assigned to their linked attendant | Start cleaning |
| In progress | Their active cleaning task | Complete cleaning with optional notes |
| Completed today | Their completion records for the property's local calendar day | View only; Recent history shows up to 100 completions |

Requests and assignments refresh every 30 seconds, or with Refresh tasks.
Owner/Admin and Front Desk Board and Information screens now refresh on the same
schedule. See Automatic updates below for the visibility and save safeguards.
When another employee claims a request or receives a direct assignment, their
room and attendant name appear under Team assignments with Assigned or In
progress status. This lists up to 100 current assignments for other attendants
in the same property; completed jobs leave this list. It is not acceptance or
completion history, and direct assignments are correctly labeled Assigned.
Other employees' task notes, contact details and update controls are not exposed.
The employee cannot create attendants, assign other employees, inspect rooms,
open reservations/guest information, see finance or change property settings.
Their own account/profile and sign-out controls remain available. Update
2026-10-30: a notification bell now shows current open requests and the linked
attendant's assignment/claim alerts. Owner/Admin receive the property-wide
housekeeping alerts. See [notification behavior and tests](housekeeping-notifications.md).

One attendant can have several queued assignments, but only one room in progress.
While busy, they must finish that job before starting or claiming another room.
Owner/Admin/Front Desk retain their request/direct-assignment workflow; only
Owner/Admin create or update attendant records. Owner/Admin retain inspection.

Completion changes the room to Clean, not Inspected. Existing check-in readiness
accepts Clean or Inspected; this change does not introduce mandatory inspection.
Occupied, maintenance and out-of-order rooms cannot use this cleaning workflow.

## Where to read completion notes

Updated 2026-10-28: Owner/Admin and Front Desk can read saved completion notes
under Housekeeping > Housekeeping Board > Activity. Each cleaning-completed
entry shows Completion notes below the attendant and time, when notes exist.
The same notes appear in a room's Housekeeping History inside its Assign drawer.
Newly completed work appears on the next automatic update or manual refresh.

The Housekeeping employee still reads their own notes under Completed today or
Recent history. Other employees' notes are not exposed under Team assignments.
All these views use the saved activity snapshot; a later request or reassignment
does not replace earlier completion notes. Blank/legacy notes have no empty
note panel. Request notes and inspection records are not labeled completion notes.

## Activity: who performed each action (2026-10-28)

The shared Board > Activity and per-room Assign > Housekeeping History now show
one summary card per cleaning job. Each card has visible Requested by, Assigned
by, Started by and Completed by rows with their saved names, roles and times.
Claimed by and Inspected by rows appear when those actions exist. The assigned
attendant is listed separately. These labels refer to the acting account, not
the attendant. A self-claim without a direct assignment says Self-claimed on the
Assigned by row and names the actual claimant on the Claimed by row.

For example, if an owner completes a task assigned to Nimal, the entry says
Completed by: the owner's name (Owner), and Assigned attendant: Nimal. It does
not claim Nimal clicked Complete or prove who physically performed the cleaning.
Completion notes have a two-line preview. Expand Full activity to see the
individual events, including reassignments; each event's Details contains its
full note and recorded status change. Request/assignment notes stay inside Details.

Filter by action, status, attendant and date; Search room or person matches room
number, acting account name or assigned attendant. Filters select matching jobs
while preserving all their steps, so filtering Completed does not hide who
assigned or started that job. The count is grouped cleaning jobs. Automatic
refresh preserves filters and expanded history while the job remains in the list.
On mobile the extra controls are behind Filters, with an active-filter count.
Activity uses the board's existing Refresh control; the unrelated room-card
search is hidden while the Activity tab is selected.

Grouping uses physical room identity and chronological request/dirty/completion
boundaries; it does not group all history by task_id because the task row is
reused for later cleaning. Reassignments remain within the current job; later
cleanings get separate cards. Earlier steps outside the loaded activity window
or absent from old records say Not recorded; names are never borrowed from a
previous cleaning job. No activity records are changed by this display grouping.

New self-claims persist a distinct claimed activity/audit action, while the task
itself still becomes assigned. Direct assignments remain assigned events.
Historical claims previously saved as assigned are not guessed or backfilled.
Existing saved actor names are displayed; missing roles remain unrecorded.
Legacy System defaults without an identity/role are labeled System / not recorded.
Role snapshots come from authenticated property access when each action occurs;
later role changes do not rewrite history. Acting identity comes from the verified
JWT; supplied actor fields/headers cannot override it. Automatic checkout/move events may have
an actor name but no saved role; the UI does not infer one from today's membership.

The full shared timeline remains available to Owner/Admin and Front Desk under
their existing read permissions. It does not grant Housekeeping employees access
to other employees' notes or the full shared activity API.

### Test activity attribution

1. Restart the backend if it does not auto-reload; refresh the PMS. Use a test
   room and separate Owner/Admin, Front Desk and linked Housekeeping sessions.
2. As Front Desk, request cleaning. Activity should show Requested by that
   Front Desk account, with its role and time.
3. As Housekeeping, claim it. The job card should show Claimed by that login;
   the attendant name is listed separately. A direct assignment of another test
   room should instead say Assigned by the Owner/Admin/Front Desk who saved it.
4. As Owner, start cleaning the claimed room. Then as Administrator, complete
   it with a note. The same card must show the requester, assignment/claim,
   Owner on Started by and Administrator on Completed by, retaining the assigned
   attendant's name separately. Repeat cleaning later: it must be a separate card.
5. Check both Board > Activity and the room's Assign > Housekeeping History.
   Use the Claimed action filter or search an actor name; all that job's steps
   should remain visible. Expand Full activity, then an event's Details to verify
   the full note/status change. Wait for a refresh: filters/details stay.
6. An older entry without actor/role data must not borrow the current attendant's
   identity or guess the person's old role. Older self-claims may say Assigned.

Verification: all 240 backend tests passed, including independent actor/attendant
identity for Owner/Admin actions, explicit claim auditing and spoofed actor data.
Frontend TypeScript and isolated browser checks verified compact attribution,
filters, note details, legacy fallbacks and existing automatic refresh workflows.
These checks use isolated fixtures; live two-account acceptance remains local.

The grouped-card UX update also passed six frontend grouping tests (run
`node --test test/housekeeping-activity-jobs.test.cjs` in new-pms), frontend
TypeScript and isolated desktop/mobile browser checks. Tests cover distinct
actors in one card, repeat room cleanings, claims/reassignments, missing history,
stable card keys and filters retaining the complete workflow context.

## Automatic updates (2026-10-28)

- Owner/Admin/Front Desk Board refreshes the current property's housekeeping
  records. Information refreshes both housekeeping records and reservations.
  The app shell skips its duplicate room/reservation bootstrap on these screens.
- Housekeeping employees' Dashboard and Board continue to refresh only their
  own work API, including the permitted read-only team summary.
- Polling runs every 30 seconds while the tab is visible. It pauses while the
  tab is hidden and checks immediately on return, unless a read/save is active.
  An initial load or a request already underway can finish while hidden.
- There is one read cycle at a time per screen. Repeated Refresh clicks and
  timer ticks cannot start overlapping cycles. Saving waits for an existing
  read, pauses background polling, writes the action, then reloads fresh data.
  Attendant creation uses this save coordination too.
- Quiet updates preserve tab/date/search filters, card/table selection, open
  details and typed form notes. They do not display a page-wide loading reset.
- Temporary background failures retain the last data with an error and retry
  on the next visible tick/return/manual refresh. A successful read clears the
  warning. Employee authorization failures clear the personal work display.
- Leaving the route/property aborts the old reads and prevents stale responses
  from overwriting the new screen. No backend polling job or database write is
  performed by the refresh itself. No push/WebSocket service was introduced.
- Today still uses the existing Sri Lankan calendar date; this change does not
  connect it to the Night Audit business date or predict future room readiness.

### Test automatic updates

1. Refresh the PMS. Use a test property, an Owner/Admin or Front Desk window,
   and a separate Housekeeping login/window. Open the same property in both.
2. Leave the shared Board visible. Request/assign/start/complete a test room in
   the other window. Within 30 seconds the visible Board should show its new
   attendant/status and completion notes in Activity. No page reload is needed.
3. Open Information, select dates containing a test reservation and apply a
   search or list view. Change the reservation from another permitted window.
   The record and room/attendant status should update while filters stay set.
4. Leave room details or a request/completion-notes form open. Type notes, then
   let a background update occur. The drawer and unsaved text must stay intact.
5. Switch to another browser tab, make a change elsewhere, and return. The
   housekeeping screen should check for updates immediately. Optional: in DevTools
   Network, filter housekeeping requests to verify no periodic reads while hidden;
   one already underway may finish. Notification polling is separate.
6. Use Refresh for an immediate check. With a throttled connection, repeat it
   during an active read/save: requests should not pile up. A failed background
   read should show an error and preserve existing data until it recovers.

Verification: frontend TypeScript and isolated browser checks passed, including
simulated 30-second timer callbacks, hidden/visible transitions, held requests,
deduplication, save ordering, temporary errors/recovery and preserved filters and
notes. Browser checks use fixture data and do not change real hotel records;
the two-account live database acceptance steps above remain for local testing.

## Set up a Housekeeping login

1. Restart the backend if needed and refresh the PMS.
2. As Owner/Admin, create an active attendant from the Housekeeping board's
   assignment/attendant controls. Note their name and employee number.
3. Have the employee register a normal account with their own email/password.
   Registration alone does not give property access or choose a staff role.
4. Open Settings > Users, or Your properties > Access. Enter that registered
   email, select Housekeeping, choose the Linked attendant and Grant access.
5. To change an existing member, choose Housekeeping beside their name, select
   the attendant and Save Housekeeping access. Change linked attendant edits an
   existing Housekeeping link.
6. Sign in as the employee in a separate browser profile/private window. Open
   the assigned property. Their role should say Housekeeping.

The attendant must be active and belong to the same property. Each attendant
can link to only one login within that property. Deactivating the attendant
blocks their work API until Owner/Admin reactivate or relink it. Changing away
from Housekeeping removes the login link; existing room tasks/history are
preserved. Role revocation is enforced on subsequent API requests; refresh open
tabs to refresh navigation and labels. A role change does not cancel a request
that was already authorized and in flight.

## Manual acceptance test

Use a test property, two employee accounts and two active attendants. Use
serviceable, unoccupied test rooms; do not alter a real guest's room.

1. As Owner/Admin or Front Desk, request cleaning for room A without an
   assignment. As employee 1, refresh Requests and claim it. It moves into
   Assigned to me and shows the attendant on the owner/front-desk board.
2. Start cleaning A. It moves into In progress and the shared room shows WIP.
   Assign another room B to employee 1 before or after this exercise as allowed
   by availability checks. Starting B while A is active must fail; duplicate
   clicks must not start or complete a second operation.
3. Employee 2 must not see A under their own assignments or be able to update A.
   Their Dashboard > Team assignments should show A, employee 1's name and the
   current status. The same card has no action buttons. After completion it
   leaves the active team list. Refresh tasks or wait up to 30 seconds for updates.
   If both employees claim one pending request, only one succeeds; the other
   gets a conflict and refreshed task list.
4. Complete A with notes. It appears in Completed today and Recent history;
   the shared board shows Clean. The employee has no inspection action. A new
   request for A must not erase the previous completion history.
5. Start/finish the next assigned room. Try an empty Requests queue and an
   employee with no assignments; the screen should explain the empty state.
6. Attempt to grant the same attendant to another login: reject it. Try an
   inactive or other-property attendant: reject it. Deactivate the linked
   attendant after login: Refresh tasks should show the access error.
7. Paste another module URL, e.g. /properties/PROPERTY_ID/financials/invoices
   or /settings/users. The page must show Access restricted. Direct forbidden
   API requests also return 403; another employee's task updates return 403.
8. Revoke/change the employee's role as Owner/Admin. Their next task API call
   must fail. Check another property separately if the account has access there.

## Implementation and verification

- Property staff_roles store the role and attendant_id. No global signup role
  or automatic attendant matching by email/name is used.
- The verified account identity resolves the linked attendant on the server;
  supplied attendant/user IDs cannot redirect a claim or task update.
- Claims, starts and completions use the existing property inventory transaction
  guard; task state, room status and activity/audit writes commit together.
- The work API returns minimal room/task data; it omits guest, reservation,
  billing and property plan/member information. The team_assignments projection
  exposes only task ID, room number/type, current status, assigned attendant name
  and assignment/start timestamps. Other employees' notes and contacts are omitted.
- Completion history uses immutable cleaning_completed activity records rather
  than the current room-task row. Today follows the actual calendar date in the
  property timezone, independently of the hotel's adjustable business date.

Run npm run check:access and npm test from hotelbackend. Run the frontend's
TypeScript check from new-pms. On 2026-10-27 all 240 backend tests and the frontend
TypeScript check passed. Express/JWT tests use isolated model fixtures, including
serialized transaction mocks; they do not prove a live MongoDB commit or replace
the two-browser database acceptance test above. No real hotel records were
changed. A production build was not run against the active development server.

An isolated browser run also passed grant/link setup, own task claiming,
starting/completion/history, single-active-task controls, direct URL blocking,
profile privacy and existing Front Desk/Owner/Admin regression flows. Browser
API responses were fixtures; these checks did not write live database records.

For the 2026-10-28 dashboard update, all 36 check:access tests, the frontend
TypeScript check and isolated browser checks passed. Browser verification covered
the separate overview/board, team names/status without action controls, claiming
from the overview, existing cleaning flows and a 390px mobile layout. API tests
verify the shared projection excludes other task notes/contacts and foreign
property tasks, preserves own-task update restrictions, and removes completed
tasks from the active team list. Live two-account acceptance is still required.

## API

- GET /api/housekeeping/my-work: own requests, assignments, active work and history,
  plus the limited read-only team_assignments list for the dashboard.
- POST /api/housekeeping/rooms/:roomId/claim: claim an unassigned request.
- POST /api/housekeeping/rooms/:roomId/start: start one's own assigned task.
- POST /api/housekeeping/rooms/:roomId/complete: complete one's own active task;
  optional notes. Use normal authenticated property scope on each request.
- GET /api/housekeeping/attendants: minimal attendant options for Owner/Admin.
- POST/PATCH property access: role housekeeping requires attendant_id for the
  initial link; editing a Housekeeping member can retain their existing link.
