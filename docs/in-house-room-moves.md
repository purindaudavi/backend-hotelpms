# In-house room moves: implementation and test guide

Implemented: 2026-10-16.

## How staff use it

1. Restart the backend and refresh/restart the PMS frontend after deploying.
2. Open **Front Desk -> In House**, then select the checked-in reservation to
   open its details. The same action is available from Reservations -> Bookings
   when viewing a checked-in reservation's details.
3. Click **Move room** (beside Edit reservation).
4. Choose the current assignment when the reservation contains multiple rooms.
5. Select a clean, available destination in the **same room type**.
6. Enter the reason and click **Move guest**.

The move uses the property's current business date, not a new arrival date.
Future-date conflicts and cross-booking links are checked again on save, so a
room offered in the dropdown can still be rejected if its remaining-stay
availability has changed.

After success, the reservation remains checked in. Its current room becomes the
destination, the original room becomes operationally available but dirty, and a
cleaning task is created/reset for the original room. The destination becomes
occupied. Room statuses are reloaded from the backend, rather than depending on
a browser-only update.

Open **Rooms -> Room move history** or **Log** in the reservation details to see
the original room, destination, effective business date, timestamp, staff member
and reason. The Front Desk grid uses the original room before the move date and
the new room from the move date onward. Same-day moves retain a timestamped log
but do not invent extra overnight nights or hourly inventory slots.

If the old room needs repair, mark it Maintenance/Out of Order through the
existing room workflow. A free-text move reason does not automatically infer
maintenance status. Otherwise, assign an attendant and clean/inspect it through
Housekeeping before checking in another guest.

## Manual test: a normal move

Use a test property and synthetic guest information, not real customer records.

1. Configure at least two active rooms of the same type: 101 and 102. Both
   should initially be available and clean/inspected, without conflicting
   reservations, group holds or cross-booking restrictions.
2. Create a confirmed test reservation in room 101 covering the property's
   current business date and at least one later departure day. Use an active
   rate plan covering the dates. Check the guest in normally.
3. Note the reservation number, total, paid amount, dates and guest list.
4. Open its details from **In House -> Move room**. Select 102, enter a reason
   such as "Air conditioner needs repair", and save.

Expected:

| Item | Expected after moving |
| --- | --- |
| Reservation status | Still Checked-in |
| Current assignment | Room 102 |
| Room 101 | Not occupied; Dirty; cleaning task awaiting staff action |
| Room 102 | Occupied |
| Guest list / reservation room-line IDs | Unchanged |
| Dates / total / paid amount | Unchanged |
| Rooms history and Log | Saved 101 -> 102 move, business date, actor/time/reason |

5. Refresh the browser or open the property in another session. Verify the same
   reservation assignment, room statuses and move history remain.
6. Check out this reservation normally. Room 102 should become available and
   dirty. Room 101 must not be altered again by that checkout.

Optional stronger checkout check: after the move, clean room 101 and check a
different synthetic guest into it. Checking out the original reservation from
102 must not release the new guest's room 101.

## Rejection and history checks

- Dirty, occupied, inactive, Maintenance and Out of Order destinations are not
  valid. The UI filters current readiness; the backend enforces it again.
- Create a booking in a destination for a later date during the remaining stay.
  The move must be rejected even when that room is available right now.
- A destination used only before the effective move date should not block the
  move. The original room's historical allocation is preserved, and the new
  room is not retrospectively assigned to the guest for those earlier dates.
- Cross-booking conflicts, including a day-use booking in a linked room during
  the remaining stay, must reject the move.
- On a multi-room reservation, moving one room must leave all other assignments
  occupied and unchanged. The API also supports an all-or-nothing multi-room
  batch; the UI performs one chosen room move at a time.
- Two staff members competing for the same destination should have one winner.
  A stale request referring to the guest's previous room is rejected.
- A day-use guest can be moved on its business date without changing equal
  check-in/check-out dates or zero overnight nights.
- Ordinary Edit reservation cannot bypass Move room by replacing physical room
  assignments, room types or room lines after check-in. Arrival/stay type cannot
  be rewritten after check-in; shortening departure before the current room's
  allocation is rejected.

## Scope and safety

This release supports same-room-type moves. Room-type upgrades/downgrades and
their rate/financial decisions remain separate; the UI does not silently reprice
an in-house stay. Issued invoices are not rewritten by a room move. Existing
dates, rate plan, meal allocation snapshot, guest/occupant links and money fields
remain unchanged.

The backend performs the assignment change, both operational statuses, original
room housekeeping task/activity, room-move history and reservation audit log in
one property-guarded MongoDB transaction. Any failure rolls them all back.

Each reservation room stores a server-owned `current_assignment_from`; append-only
through the API, `room_moves` records preserve earlier room allocation intervals.
The shared backend physical-room/cross-booking checks and the Front Desk grid
honour those intervals. New/edited client payloads cannot forge these assignment
dates or erase history. No migration is needed for existing reservations: a
legacy room without assignment metadata starts at the original arrival date.

This does not automatically repair already-inconsistent room states from earlier
manual edits. A move refuses an original room not marked occupied or apparently
shared with another in-house reservation; those records need staff review.
Full staff-role permissions, room-type upgrades, hourly split-stay inventory and
unifying all other report/export consumers with allocation history remain
separate work. Existing property authorization still applies.

## API

`POST /api/bookings/reservations/:reservationId/room-moves`

```json
{
  "property_id": "your-test-property",
  "business_date": "2026-10-20",
  "reason": "Air conditioner needs repair",
  "moves": [{
    "room_line_id": "reservation-room-line-id",
    "from_physical_room_id": "current-physical-room-id",
    "to_physical_room_id": "destination-physical-room-id"
  }]
}
```

IDs must be real ObjectIds from this property/reservation. The current source
room ID is an optimistic precondition against stale forms. When the property has
a persisted business date, a mismatched client business date is rejected.
The successful response contains the updated full reservation, including move
history. Normal endpoint authentication/property authorization is unchanged.

## Automated verification

From `D:\DMS new\hotelbackend`:

```powershell
node --test test/room-move.service.test.js
node scripts/live-concurrent-bookings-smoke.js --run --room-moves-only
```

Use only the development/test database configured by the backend environment.
The smoke script refuses production mode, uses isolated namespaces in a
loopback-only harness mounting the actual routers, and removes/verifies its
temporary records, including housekeeping tasks/activities and guard documents.
It does not test application authentication or send guest emails. If forcibly
interrupted, inspect only the namespace printed by that run for leftover fixtures.

Verification performed:

- All **184 backend tests** passed, including ten move/metadata/history tests.
- **15 database-backed room-move scenarios** passed, including remaining-stay
  conflicts, future cross-linked day use, concurrency, multi-room batch rollback,
  forced mid-transaction failure, saved history and correct checkout. Cleanup
  was verified.
- Frontend typecheck passed with incremental output disabled.
- Scripted checks of actual frontend helpers passed for historical room dates,
  old-room release/current assignment, and day-use overlaps.
- The combined **38 database-backed scenarios** also passed: 13 concurrency,
  ten day-use and 15 room-move checks. Temporary fixture cleanup was verified.
- No interactive browser test has been performed by the agent.
