# Day-use availability fix and testing

Implemented: 2026-10-16.

## What changed

A day-use booking uses a room on its arrival date, despite having equal arrival
and departure dates and zero overnight nights. The backend now includes those
records in availability searches at range boundaries.

For example, active day use on October 20 conflicts with another day-use booking
on October 20 or an overnight booking arriving October 20. It does not block
October 21. An ordinary October 19-20 overnight stay still releases its date
inventory on October 20; physical check-in also requires the prior guest to have
checked out and the room to be ready.

The availability-only interval is `[arrival day, next day)` for day use, while
ordinary overnight intervals remain `[arrival day, checkout day)`. The system
does not change the stored checkout date or charge an extra overnight night.
Existing records flagged as day use consume their arrival day even if a legacy
record has a later checkout, matching the existing day-use dashboard convention.

The change covers:

- Room-type capacity and specific physical-room assignment, on create and edit.
- Day use versus day use, day use versus overnight stays, and range boundaries.
- Active group holds and group activation against existing day use.
- Existing cross-booking links, and attempts to create links between rooms that
  already have conflicting day-use reservations.
- The existing property transaction guard for simultaneous requests.
- Check-in: a day-use reservation may be checked in only on its arrival business
  date, not on a later day.

Active statuses continue to consume inventory. Cancelled, no-show, checked-out
and archived reservations follow the existing exclusions. Editing excludes the
reservation itself. No data migration or OTA connection is required.

## Test in the PMS

Use a test property and synthetic guests. Restart the backend, refresh the PMS,
and ensure the room list/reservation data are current.

1. In Room & Rates -> Rooms, configure a test room type with exactly one active,
   sellable physical room, such as 101. Ensure no other bookings, active group
   holds or cross-booking restrictions affect the example dates.
2. Configure an active Room Only rate plan covering the test dates if required
   by the reservation form. Use future dates relative to the property's business
   date if needed; shift all example dates together.
3. In Front Desk -> New reservation, select **Day room**, choose October 20,
   select room 101, and enter valid synthetic guest details. The form should
   show October 20 for both dates and zero nights. Use Tentative if you want to
   avoid the normal invoice workflow associated with confirmation.
4. Save this as Test A. It should save successfully.

With A still active, try these cases:

| Case | Dates / room | Expected result |
| --- | --- | --- |
| Test B, another day-use booking | October 20, room 101 | Rejected as unavailable/overlapping |
| Test C, an overnight booking | October 20-21, room 101 | Rejected as unavailable/overlapping |
| Test D, next-day day use | October 21, room 101 | Saves if otherwise available |
| Edit Test A without changing dates or room | October 20, room 101 | Saves; no self-conflict |

Then cancel A through the PMS, refresh availability in the other session, and
retry B. B should now save. If a form still has an outdated selection, reselect
the room; the backend always checks current inventory before saving.

Additional checks:

- On another empty date, make an ordinary overnight booking ending October 24.
  A day-use booking for October 24 should be allowed, subject to room readiness
  before actual check-in.
- With two sellable rooms of the same type, two day-use bookings on October 25
  should save when assigned to different, non-cross-linked rooms.
- For check-in, use a confirmed day-use test reservation on the property's
  selected business date and a clean/available room. A request using a later
  business date should be rejected.

No morning/afternoon slots were added. While active, a day-use booking reserves
that calendar day's inventory; the PMS does not assume two guests can share the
same room at different times. Zero overnight nights does not make the day-use
stay free: existing rate/charge behavior is unchanged.

## Automated checks

From `D:\DMS new\hotelbackend`:

```powershell
node --test test/booking-inventory-dates.service.test.js test/booking-availability.service.test.js
npm run check
```

Database-backed day-use checks:

```powershell
node scripts/live-concurrent-bookings-smoke.js --run --day-use-only
```

Use only a development/test MongoDB deployment supporting transactions. This
script refuses `NODE_ENV=production`, uses uniquely scoped synthetic records,
and cleans up only its own namespaces with verification. It mounts the actual
booking/cross-booking routers in a loopback-only harness limited to those
namespaces; it does not replace the running PMS server or test authentication.
It sends no guest emails. No live OTA connection is needed.

There are ten day-use scenarios: saved dates/zero nights/price/edit/cancel/retry;
day use blocking overnight arrivals; overnight boundaries; group hold boundaries;
physical-room conflicts and retroactive links; existing cross-booking links;
group activation; simultaneous day-use requests; simultaneous day-use versus
overnight requests; and check-in on the correct business date.

To include the thirteen original concurrency scenarios as well:

```powershell
node scripts/live-concurrent-bookings-smoke.js --run
```

To run all backend tests:

```powershell
$testFiles = @(rg --files test -g '*.test.js')
node --test --test-reporter=spec @testFiles
```

## Verification and remaining scope

### Follow-up: frontend Nights field

The reservation editor in the separate frontend was subsequently corrected after
the owner reported that ticking Day room still displayed one night. The checkbox
now sets form nights to zero and matches checkout to check-in; unchecking it
restores at least one overnight night. Reopened day-use drafts normalize to zero,
and the disabled Nights field explicitly displays zero when Day room is selected.
Day-use pricing still uses one charge unit, not zero: both the UI total and saved
reservation total remained LKR 6,500 in the regression check. Frontend typecheck
passed, and the actual form-update/initialization/total functions passed scripted
toggle, date-change, reopen and price-preservation checks. No browser automation
was performed. Refresh the PMS and toggle Day room to verify visually.

- All 174 backend tests passed, including 16 new day-use availability cases and
  six new date-helper cases.
- Backend syntax checks passed.
- All ten database-backed day-use scenarios passed; cleanup was verified.
- The full database-backed regression run also passed: thirteen original
  concurrency scenarios plus ten day-use scenarios (23 total), with cleanup
  verified after completion.
- Manual browser testing has not been performed by the agent.

This fixes authoritative backend availability and the related check-in boundary.
The frontend's local room-overlap helper can still offer a room that the backend
then rejects on save; unifying client-side inventory displays remains separate
work. Hourly slots, separate day-use pricing policies, report/Night Audit
day-use consistency review and live channel integration are not implemented by
this change.
