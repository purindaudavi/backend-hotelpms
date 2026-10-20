# Physical room status, disable and delete safeguards

Implemented: 2026-10-16. These rules protect physical rooms and room types.
They do not restrict or replace the reservation-status dropdown.

## What changed

- An occupied physical room cannot be manually made Available, Maintenance or
  Out of Order, disabled or deleted. Check out or Move room first. A persisted
  checked-in assignment also protects the room if its operational flag is stale,
  including an overdue departure. Harmless notes/floor edits remain possible.
- Occupied is set by reservation check-in, not by manually creating/editing a
  room. Room moves/checkouts continue through their existing transaction paths.
- Confirmed, Tentative, Checked-in and Blocked reservations protect current and
  upcoming assignments. An assigned room cannot be taken out of service until
  the affected reservation is reassigned or cancelled. Cancelled, No Show,
  Checked-out and deleted reservations do not reserve future inventory.
- A room can remain Available today despite an upcoming reservation. These
  checks do not mark it Occupied early.
- Reducing sellable capacity also checks unassigned reservations and active group
  holds, per date. Pickups replace holds rather than being counted twice. Day-use
  reservations count on their arrival day, despite having zero overnight nights.
- Room types needed by in-house/upcoming reservations or unreleased upcoming
  active/tentative groups cannot be disabled/deleted.
- Past reservation/move history prevents hard deletion or renaming of referenced
  room identities. Disabling is allowed once there is no active/future conflict.
  Saved rate references protect room-type identities; housekeeping history and
  cross-booking links also prevent destructive deletion/renaming.
- The `force=true` deletion bypass was removed. The same safety checks apply to
  every authorized caller, including owners/administrators. This is not a new
  staff-role permission system; existing property authorization is unchanged.
- Booking validation now rejects an explicitly selected Maintenance/Out of Order
  room even if the room type has spare capacity in another physical room.

Validation and saves use the existing shared property inventory transaction,
so simultaneous bookings, room moves and catalog mutations are coordinated.
Rejected requests return HTTP 409 with a short explanation and save no changes.
The existing Rooms UI displays these backend messages; no frontend change was
required for this implementation.

## Manual tests in the PMS

Restart the backend and refresh the PMS. Use synthetic guests and a test property.
Use the property's current system/business date for the following tests.

### 1. A future assigned reservation protects its room

1. Have rooms T101 and T102 in the same active type, Available and clean.
2. Create a Confirmed reservation arriving tomorrow and departing two days later.
   Explicitly assign T101; do not check it in yet.
3. Open Room & Rates -> Rooms -> Physical Room List, edit T101 and select
   Maintenance; save. Repeat with Out of Order.
4. Both changes should be rejected, with a message identifying the reservation
   and asking for reassignment/cancellation. T101 remains Available after refresh.
5. Edit the reservation and assign T102 instead; save. T101 can now be marked
   Maintenance if no other reservation/hold needs that capacity.

The restriction covers all future dates because the current status has no
scheduled end date. It does not assume repairs finish before a later arrival.

### 2. An occupied room requires a move or checkout

1. Create a reservation covering the business date in T102 and check it in.
2. Try changing T102 from Occupied to Available, Maintenance or Out of Order.
   The existing UI may stop the attempt before sending; the backend now enforces
   the same rule even if the UI is bypassed.
3. Move the guest to another clean, available room using Move room. The old room
   can then be marked Maintenance if no future assignment needs it.
4. The reservation remains Checked-in in the destination; amounts/dates do not
   change. Alternatively, a normal checkout releases the current room for cleaning.

### 3. Check capacity without an assigned room number

1. In a type with exactly two sellable physical rooms, create an upcoming
   reservation needing both rooms; leave the physical numbers unassigned if the
   reservation form supports it.
2. Try marking either physical room Maintenance. Expect a rejection showing the
   date, remaining sellable capacity and number of rooms needed.
3. Cancel/reduce/reassign that reservation appropriately and repeat. The change
   should succeed once enough capacity remains. An active group hold can be used
   for an equivalent test; release enough held stock before retrying.

### 4. Confirm normal changes still work

- With no affected booking/hold, Available -> Maintenance -> Available succeeds.
- A room with completed reservation history cannot be hard-deleted or renamed;
  keep its identity and disable it when safe. The UI may already enforce this.
- A never-used, unoccupied room with no links/history can still be removed if
  doing so does not undermine future type-level capacity.
- Changing a housekeeping status does not change an occupied room to Available.

Some backend-only actions, such as a physical room's `active=false`, are not
exposed as controls in the existing Rooms UI. The automated API scenarios cover
disabling, type deletion, occupied creation and `force=true` bypass attempts.

## Automated checks

From `D:\DMS new\hotelbackend`:

```powershell
$testFiles = @(rg --files test -g '*.test.js')
node --test @testFiles
node scripts/live-room-safeguards-smoke.js --run
node scripts/live-concurrent-bookings-smoke.js --run
```

Live scripts are opt-in and refuse production mode. Use only the development/test
database. They mount actual routers in loopback-only harnesses scoped to random
temporary test namespaces. They verify cleanup of their own records and do not
send guest emails or test the production authentication middleware. A forcibly
interrupted run may need cleanup limited to its printed namespace.

Verification: 206 backend tests, all 16 database-backed room-safety scenarios and
the existing 38-scenario concurrency/day-use/room-move regression suite passed.
Temporary fixture cleanup was verified for both live suites. Syntax checks
passed. Interactive browser testing remains for the property owner; no browser
walkthrough is claimed.

## Limits

- No changes to reservation statuses, role administration or OTA connectivity.
- No dated maintenance windows: taking a room offline is indefinite until changed.
- No automatic repair of inconsistent legacy assignments or status flags. Review
  those records instead of using manual availability changes to conceal them.
- Existing UI workflows may apply stricter restrictions (for example, disabling
  a type that still lists physical rooms). Those frontend rules were not relaxed.
- This safeguards catalog mutations; it does not unify every dashboard/report's
  historical room-allocation calculations.
