# Project reference

For the DMS PMS audit, implemented features, known gaps, test results, and
recommended completion order, see [docs/PROJECT_AUDIT.md](docs/PROJECT_AUDIT.md).

The report was saved on 2026-10-16 from the preceding read-only audit. It is a
historical baseline, not a guarantee of the current code or production readiness.
Verify the relevant implementation before relying on a finding or marking it fixed.

The associated PMS frontend is at `D:\DMS new\new-pms`. Real Channel Manager OTA
integration was unfinished at the audited snapshot; the development test channel
must not be confused with a production OTA connection.


## PMS rules to preserve

- Before editing a workflow, check its existing routes, services, and tests for reusable logic.
- Money requests: Approving a request or reporting advance spending leaves the
  recorded funds balance unchanged. Marking it Paid deducts the amount once.
  Only the property Owner can settle an advance. Add unused funds back only
  after the Owner confirms receiving them. See `routes/money-requests.js`,
  `services/recorded-funds.service.js`, and `test/money-requests.test.js`.
- Property access: Check property membership and role on the backend for every
  private booking and invoice read or write. See
  `services/property-access.service.js`, `services/property-permissions.service.js`,
  and `test/property-access.test.js`.
- Booking availability: Preserve per-night inventory checks and protections
  against concurrent bookings overselling rooms. See
  `services/booking-availability.service.js`,
  `services/inventory-transaction.service.js`, and
  `test/booking-availability.service.test.js`.
- Run the relevant tests after changing any of these workflows.
