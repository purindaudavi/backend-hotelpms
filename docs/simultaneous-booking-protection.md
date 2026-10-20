# Simultaneous booking protection

Implemented: 2026-10-16.

## What this fixes

When one room remains, two requests must not both read "one room available" and
then save two separate reservations. The previous per-night fix corrected the
calculation; this change coordinates competing database transactions.

There is now one permanent `inventory_guards` document per property, identified
by its unique `_id`. Before reading inventory, each protected transaction
increments that property's guard revision. Competing transactions must write
the same document, so MongoDB raises a write conflict rather than letting both
save from the old inventory snapshot. The driver retries the entire transaction,
including the guard write and availability check, using a fresh snapshot.

The losing request can then return HTTP 409 with the normal unavailable-room
message. When enough inventory exists, both requests can succeed. Different
properties use different guard documents and do not block each other.

The guard is a transaction write, not a browser flag, in-memory mutex, or TTL
lock. It remains effective across independent backend processes connected to the
same database. Failed transactions roll back; there is no persistent "locked"
boolean that needs manual clearing. The revision document is intentionally kept
for future saves and must not be deleted while requests are running.

## Coverage and operating requirements

The shared wrapper covers:

- Reservation creation, edits and lifecycle changes, including cancellation,
  deletion, check-in and checkout.
- Business block edits, activation, release/cancellation and allocation pickup.
- The simulated/test-channel reservation importer.
- Room-type and physical-room catalog changes, including operational status.
- Cross-booking relationship creation, activation/deactivation and deletion.
- Housekeeping task mutations affecting room readiness.

Existing transaction-backed booking metadata/payment operations also use the
same conservative property guard. This first version prioritizes correctness
over maximum same-property write throughput. Read-only screens are not queued.

MongoDB must support multi-document transactions (a replica set or sharded
cluster, such as Atlas). No Redis or new credentials are required. The guard
collection/document initializes automatically; its built-in unique `_id` index
is sufficient. If transactions fail, the code never falls back to an unprotected
save. Retries have a 15-second transaction budget; persistent contention or an
uncertain commit returns 503 and asks the user to refresh before retrying.

Restart every backend process after deploying. A still-running old process or a
future integration that writes reservations directly without this wrapper could
bypass the protection. Any new inventory writer must call
`withInventoryTransaction(propertyId, async (session) => { ... })`, perform its
reads and writes with that session, and keep external side effects out of the
retryable callback. Construct/refetch mutable documents inside that callback.

## Test in the PMS

Use a test property and synthetic guests. Do not test against real customer
reservations. Restart the backend, then refresh both browser sessions.

1. Create a room type with exactly **one active sellable room**. It must not be
   under maintenance or out of order. Ensure there are no existing reservations,
   group holds or cross-booking restrictions for the test dates.
2. Configure a valid Room Only rate plan if the reservation form requires one.
3. Open the same test property in two browser sessions, both signed in with
   access to that property. This can be two browsers or two staff accounts.
4. Prepare a new reservation in each session for the same room type and dates,
   for example October 20-22, 2026. Use different guest names/emails. Use future
   dates relative to the property's business date if needed.
5. Click Save in both sessions as close together as possible.

Expected: exactly one reservation saves. The other shows an unavailable-room or
assignment-conflict message. Refresh Reservations and verify only one active
test reservation exists for that room/stay.

Then cancel the successful test reservation through the PMS and try saving the
other one again. It should succeed because the room has been released. Normal
confirmed-booking invoice/cancellation rules still apply; tentative reservations
also consume availability and can be used for this test without issuing invoices.

As a positive check, repeat on a different empty date with two sellable rooms in
the room type. Two one-room requests should both save. This verifies that the
protection is not simply rejecting every second request.

Two manual clicks cannot reliably reproduce millisecond timing. Use the
automated test below for a more reliable concurrency check.

## Automated tests

From `D:\DMS new\hotelbackend`:

```powershell
node --test test/inventory-transaction.service.test.js test/booking-availability.service.test.js
npm run check
```

For the full backend test suite:

```powershell
$testFiles = @(rg --files test -g '*.test.js')
node --test --test-reporter=spec @testFiles
```

For the database-backed race tests:

```powershell
node scripts/live-concurrent-bookings-smoke.js --run
```

Run this only with a development/test database in the backend environment. It
refuses `NODE_ENV=production`. It uses temporary, uniquely generated property
namespaces and a loopback-only Express harness mounting the actual routers.
The harness accepts only its own temporary namespaces. It does not replace the
running PMS server or exercise the production authentication middleware.

The script exercises competing HTTP requests through two local server instances,
the actual test-channel importer, and two separate Node child processes sharing
MongoDB. It needs no real OTA connection and sends no guest emails. It verifies:

1. Cold-start guard creation and last-room competition: one winner, no orphan
   guest from the rejected save; cancellation releases availability.
2. Two rooms available: both one-room requests succeed.
3. Competing two-room requests: only one complete reservation, no partial save.
4. Non-overlapping nights: both bookings succeed.
5. Competing cross-linked physical rooms: one winner; link CRUD still works.
6. Competing date edits: only one can move into the final available room.
7. Group activation versus an individual reservation: one winner.
8. Last group allocation pickup: one reservation and one invoice.
9. Manual reservation versus the test-channel importer: one winner.
10. Separate backend processes racing the same final room: one winner.
11. Aborted transaction: a later request is not stuck behind a stale lock.
12. Guarded room catalog create/edit/status/delete actions still work.
13. A held guard for one hotel does not lock another hotel's writes.

The script removes records only from its own generated namespaces in `finally`,
including guard records, and verifies cleanup. If forcibly interrupted, inspect
the namespace printed at startup for leftover test records; do not broadly
delete records from other properties.

The script now also runs ten day-use scenarios by default, in addition to the
thirteen cases above. Use `--run --day-use-only` to run just those ten scenarios.
See [the day-use implementation and guide](day-use-inventory.md).

It subsequently gained fifteen in-house room-move scenarios as well. Use
`--run --room-moves-only` for that isolated set; see
[the room-move guide](in-house-room-moves.md). The default full run now includes
all 38 scenarios; `--day-use-only` still selects only the ten day-use scenarios.

## Verification and limits

### Follow-up: clearer reservation errors

Booking validation responses now provide short guidance instead of only
"Booking data validation failed." Guest-field errors identify the relevant
field; invalid room/rate selections ask for reselection; mismatched guest-to-room
references ask the user to reopen and review the reservation. Actual room/date
overlap errors ask the user to refresh availability and try again. Validation
errors remain HTTP 400 and inventory conflicts remain HTTP 409; they are not
mislabelled as the same problem. The existing frontend displays these backend
messages without a frontend change. Detailed validation errors remain available
in the API response.

The exact cause of the owner's reported failed retry in an already-open tab has
not been reproduced. This change improves feedback; it does not implement
automatic refresh/recovery of that open form. Six new tests cover validation
wording and the actual booking HTTP error response (mocked database models).

- All 152 backend tests passed after the message update, including 12 guard/retry
  tests, 25 per-night availability tests and six validation-message tests.
- Backend syntax checks passed.
- All 13 database-backed scenario checks passed, including separate Node
  processes, room catalog actions and independent-property writes. Temporary
  test records were removed and cleanup verified.
- Manual browser testing has not been performed by the agent.

This fixes coordination between the protected PMS writers. Day-use overlap
handling was subsequently fixed; see [the day-use guide](day-use-inventory.md).
This does not add live OTA integration or prevent an administrator deliberately
reducing inventory after a booking has committed.
Those validation/integration issues remain separate. It also does not undo an
external OTA booking already accepted by the provider; later real connectors
will need their own conflict handling and availability synchronization.
