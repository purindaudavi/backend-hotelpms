# Per-night inventory fix and test guide

Implemented: 2026-10-16.

## What changed

The shared backend availability validator now checks each requested stay night
separately, by room type. It no longer adds together all bookings that overlap
any part of a multi-night stay.

For each night:

`available rooms = active sellable rooms - reservations that night - remaining group holds that night`

Group pickups reduce their allocation's remaining hold on the nights they
actually occupy, avoiding double counting. Checkout is exclusive for overnight
stays. Capacity shortages identify the room type, available quantity and date.
Dates follow the existing PMS UTC-calendar-date convention.

Existing safeguards remain: property scope, reservation-edit self-exclusion,
active reservation statuses, group-block exclusions, physical-room overlap and
cross-booked physical-room checks. Inactive, maintenance and out-of-order rooms
do not increase sellable capacity.

This shared validator is already called by reservation creation/editing, business
block validation/pickup and the development OTA reservation importer. No live OTA
connection was added, no frontend files changed, and no data migration is needed.

## Manual PMS test

Use a test property, not real customer bookings. Restart the backend so it loads
the updated code, then refresh the PMS. If using `npm run dev`, nodemon should
reload automatically; otherwise stop the existing backend and run `npm start`
again from `D:\DMS new\hotelbackend`.

1. In Room & Rates -> Rooms, create a test room type with exactly two active,
   sellable physical rooms: 101 and 102. Keep both operationally available.
2. If required by the reservation form, configure an active Room Only rate plan
   for this room type covering October 20-23, 2026. Use future dates relative to
   the property's business date if necessary; shift all the example dates
   together.
3. Ensure no other bookings, active group holds or cross-booking links affect
   these test rooms/dates.
4. Create these confirmed reservations, using normal required guest details:

| Reservation | Physical room | Check-in | Check-out | Expected result |
| --- | --- | --- | --- | --- |
| Test A | 101 | October 20 | October 21 | Saves |
| Test B | 101 | October 21 | October 22 | Saves; A checks out before B's overnight stay |
| Test C | 102 | October 20 | October 22 | Saves; room 102 is free for both nights |

Step C reproduces the original bug: before this change it could report zero
availability even though room 102 was free.

Then check the protections:

1. With C still active, try adding another reservation of this room type for
   October 20-22. Leave its physical room unassigned if the form permits it.
   Expect rejection with `0 sellable room(s) available on 2026-10-20`.
   If you select a physical room instead, the existing room-assignment overlap
   error can appear first; that is also correct.
2. Open C and save it without changing its room or dates. Expect success, not
   rejection from counting C against itself.
3. Try assigning room 101 to another reservation for October 20-22. Expect a
   physical-room overlap rejection.
4. Create a one-night test reservation for October 22-23 in room 102. Expect
   success: October 22 is C's checkout date, not another occupied night.

Optional group-hold test, on otherwise empty October 24-26 dates:

- Create an active one-room business block for October 24-25, and a different
  active one-room block for October 25-26, using the same two-room type.
- A one-room reservation for October 24-26 should save: each night has one
  remaining free room.
- With that reservation saved, another one-room booking for those dates should
  be rejected.

Use synthetic guest information and do not send guest emails. Manual confirmed
reservations can create automatically issued invoices; keep this exercise in a test
property and handle those test documents through the normal PMS workflow.

## Automated tests

From `D:\DMS new\hotelbackend`:

```powershell
node --test test/booking-availability.service.test.js
npm run check
$testFiles = @(rg --files test -g '*.test.js')
node --test --test-reporter=spec @testFiles
```

The new test file contains 25 regression tests. It uses mocked database models
with query filters and field projections, so it needs no MongoDB connection.
The original staggered-booking scenario was confirmed failing before the fix.

An optional database-backed smoke test is also available:

```powershell
node scripts/live-nightly-inventory-smoke.js --run
```

Run this only against a development/test database configured in the backend
environment. It refuses `NODE_ENV=production`, creates uniquely scoped synthetic
room/reservation/block records, runs seven checks through the actual shared
service and MongoDB, and deletes only its own recorded fixture IDs in `finally`.
It does not send emails or create invoices. The backend HTTP server is not needed
for this script. This is a service/database test, not a browser or HTTP route test.
If interrupted forcibly, use the printed test namespace to identify any fixtures
that need cleanup; do not delete another property's data.

Verification on implementation day:

- Backend syntax checks passed.
- All 134 backend tests passed, including 25 new availability regression tests.
- All seven MongoDB service smoke checks passed; fixture cleanup was verified.
- Manual browser testing has not been performed.

## Still separate work

- Simultaneous-booking protection was subsequently added; see
  [the concurrency implementation and test guide](simultaneous-booking-protection.md).
- Fully unifying frontend inventory displays and channel inventory with the
  authoritative backend calculation.
- Same-day/day-use availability was subsequently corrected; see
  [the day-use implementation and test guide](day-use-inventory.md).
- Other audit findings, including live provider integration, remain separate.
