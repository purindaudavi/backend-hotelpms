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
- Past reservation/move history prevents hard deletion or renumbering of referenced
  physical rooms. Disabling is allowed once there is no active/future conflict.
  Saved rate references and housekeeping history also prevent deletion.
- Owner/Admin may rename a room type's display name (updated 2026-11-27).
  Its `_id`, physical room IDs, rates and booking links stay unchanged; historical
  reservation, housekeeping and issued invoice descriptions are not rewritten.
  Unique names per property and all disable/delete/capacity checks still apply.
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

### 5. Rename a room type without changing its identity

1. Sign in as the property's Owner or Administrator. Open Room & Rates -> Rooms
   -> Edit Room Type, change the name and save. Refresh to confirm it persists.
2. Confirm the same physical room numbers and prices appear in Rooms and Rates.
   The room type `_id` and physical room IDs in MongoDB must stay unchanged.
3. Open a reservation created before the rename. Its existing room assignment,
   dates and price remain unchanged; the editor selects the renamed type by ID.
4. Check an unassigned Confirmed booking in Front Desk: it must still appear
   under the renamed group and reduce availability on its stay dates.
5. Check an issued invoice from before the rename: its description, amount,
   status and payments stay unchanged. Historical snapshots are not migrated.
6. If this type is offered through IBE, refresh/search the guest site. The new
   name appears with the same pricing and availability rules.
7. Try an existing type's name: the save must fail without changing either type.
   Front Desk, Housekeeping, Finance and general members cannot rename types.
   Renaming and disabling/deleting are separate actions; the latter still obey
   reservation, housekeeping and capacity safeguards.

No database migration or bulk rewrite of historical records is required.

For the separate fix allowing multiple room types to have no physical rooms,
including removal of a type's last unused room, see
[Physical room-number index](physical-room-number-index.md). Existing databases
need its targeted index migration; the room safety rules above still apply.

## Room unassignment and reassignment (2026-11-27)

- In Edit Room Type → Physical Rooms, removing a saved room with × and saving
  **unassigns** it. It remains in Physical Room List with Room Type = Unassigned.
  Cancel does not persist the change. Removing a newly entered, unsaved number
  simply cancels that addition.
- Owner/Admin can assign it through Physical Room List → Edit → Room Type, or
  through another type's **Assign an existing unassigned room** selector.
- Only Owner/Admin may unassign, transfer or permanently delete rooms. These
  checks are enforced on the backend, including direct DELETE requests from
  legacy general members. No separate Manager role was introduced.
- Unassignment keeps the physical-room `_id`, number, floor, operational and
  cleaning details, notes and creation timestamp. Reservations, invoices, saved
  rate plans and completed housekeeping history remain unchanged. Direct type
  transfers also retain the same room ID.
- Assigned rooms continue using the existing `room_types.physical_rooms` storage.
  Only unassigned rooms are stored in `unassigned_physical_rooms`. They are
  returned separately as `unassigned_rooms` to Owner/Admin; the ordinary room
  catalog, Front Desk inventory, dashboard and IBE do not treat them as stock.
  No bulk migration of existing rooms is needed. Include the new collection in
  property backups. The room-number index fix described above still applies.
- Assignment changes use the same property inventory transaction as bookings.
  Occupied rooms, current/future physical assignments, open housekeeping work,
  and insufficient remaining type capacity (including unassigned bookings and
  group holds) reject the change. Failed batch saves roll back type details and
  all room changes. Past history alone does not prevent unassignment, but still
  prevents permanent deletion/renumbering after a transfer.
- New/renamed room numbers are checked across assigned and unassigned rooms.
  The editor submits `expected_version`; Physical Room List submits
  `expected_room_type_id`, so stale saves and simultaneous claims are rejected.

API: PATCH `/api/rooms/:roomTypeId` with `room_numbers` performs the assignment
changes atomically with type details. POST `/api/rooms` accepts that field for a
new type. PATCH `/api/rooms/physical-rooms/:physicalRoomId/assignment` accepts
`room_type_id` (null means Unassigned). Permanent deletion remains separate in
Physical Room List, using the existing assigned-room DELETE endpoint or DELETE
`/api/rooms/unassigned-physical-rooms/:physicalRoomId`.

Regression test: `node --test test/room-assignment.test.js`. It starts a disposable
local MongoDB replica set; set `MONGOD_BINARY` when MongoDB is installed elsewhere.
It never uses the application database URI. Checks cover preserved history/IDs,
role/property boundaries, duplicate numbers, IBE exclusion, rollback, occupied
rooms, future reservations, housekeeping, stale saves and concurrent assignments.

Browser verification uses a disposable API/database and intercepts all API calls:
× + save → Unassigned, both themes, reassignment from Physical Room List and the
room-type selector. No DELETE request occurs when unassigning.

Verification for this change: 124 relevant backend tests passed, including the
real MongoDB/API integration scenarios above. Frontend TypeScript and the
browser walkthrough passed; the Unassigned pill was visually checked in both
themes. The final preview used its own build cache and disabled the development
inspector only for that temporary preview process.

## Earlier safeguard checks

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
