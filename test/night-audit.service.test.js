const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const BookingAuditLog = require("../db_models/booking-log.model");
const NightAudit = require("../db_models/night-audit.model");
const {
  addDays,
  buildNightAuditSteps,
  dateKey,
  dateOnly,
  nightAuditCanComplete,
  unresolvedBlockers
} = require("../services/night-audit.service");

function audit(overrides = {}) {
  return new NightAudit({
    property_id: " demo ",
    business_date: new Date("2026-08-04T14:30:00.000Z"),
    currency: "lkr",
    reviewed_step_ids: [],
    overrides: [],
    ...overrides
  });
}

function snapshot(overrides = {}) {
  return {
    currency: "LKR",
    in_house: [],
    due_arrivals: [],
    overdue_arrivals: [],
    due_departures: [],
    estimated_room_revenue: 0,
    revenue_posted: false,
    revenue_posted_amount: 0,
    deposit_total: 0,
    open_balances: [],
    dirty_rooms: [],
    out_of_order_rooms: [],
    channel_manager: { connected: false, requested_active: false, configured_property_id: "" },
    ...overrides
  };
}

test("night audit model normalizes identifiers, currency, notes, and reviewed steps", async () => {
  const record = audit({
    reviewed_step_ids: ["front-desk-status", "front-desk-status"],
    close_note: "  handed over to morning shift  "
  });
  await record.validate();

  assert.equal(record.property_id, "demo");
  assert.equal(record.currency, "LKR");
  assert.equal(record.close_note, "handed over to morning shift");
  assert.deepEqual(record.reviewed_step_ids, ["front-desk-status"]);
});

test("shared audit log accepts Night Audit actions", async () => {
  const log = new BookingAuditLog({
    property_id: "demo",
    entity_type: "night_audit",
    entity_id: new mongoose.Types.ObjectId(),
    action: "night_audit_step_reviewed",
    description: "Front Desk Status was reviewed."
  });
  await log.validate();
});

test("closed night audit requires close and next-business-date fields", async () => {
  const record = audit({ status: "closed" });
  await assert.rejects(record.validate(), /requires closed_at and next_business_date/);

  record.closed_at = new Date("2026-08-04T23:00:00.000Z");
  record.next_business_date = new Date("2026-08-05T00:00:00.000Z");
  await record.validate();
});

test("night audit steps block close until revenue and report work is complete", () => {
  const record = audit();
  const steps = buildNightAuditSteps(record, snapshot({
    in_house: [{ reservation_id: "1" }],
    estimated_room_revenue: 33000,
    open_balances: [{ reservation_id: "1", reservation_no: "RES-1", guest_name: "Guest", currency: "LKR", balance: 12000 }]
  }));

  assert.equal(steps.find((item) => item.id === "folio-posting").status, "blocked");
  assert.equal(steps.find((item) => item.id === "payment-reconciliation").status, "warning");
  assert.equal(steps.find((item) => item.id === "channel-check").status, "disabled");
  assert.equal(steps.find((item) => item.id === "channel-check").required, false);
  assert.equal(steps.find((item) => item.id === "audit-reports").status, "blocked");
  assert.equal(nightAuditCanComplete(steps), false);
  assert.deepEqual(unresolvedBlockers(steps).map((item) => item.step_id), ["folio-posting", "audit-reports"]);
});

test("reviewed required steps permit close while acknowledged balance warnings remain visible", () => {
  const reportRunId = new mongoose.Types.ObjectId();
  const record = audit({
    reviewed_step_ids: [
      "front-desk-status",
      "folio-posting",
      "payment-reconciliation",
      "housekeeping-close",
      "audit-reports"
    ],
    revenue_posted_at: new Date(),
    revenue_posted_amount: 33000,
    revenue_transaction_id: new mongoose.Types.ObjectId(),
    reports_generated_at: new Date(),
    reports: [{ report_type: "business-analysis", title: "Business Analysis", report_run_id: reportRunId, generated_at: new Date() }]
  });
  const steps = buildNightAuditSteps(record, snapshot({
    revenue_posted: true,
    revenue_posted_amount: 33000,
    estimated_room_revenue: 33000,
    open_balances: [{ reservation_id: "1", reservation_no: "RES-1", guest_name: "Guest", currency: "LKR", balance: 12000 }]
  }));

  assert.equal(steps.find((item) => item.id === "payment-reconciliation").status, "reviewed_with_warnings");
  assert.equal(nightAuditCanComplete(steps), true);
});

test("business date helpers use stable UTC calendar dates", () => {
  assert.equal(dateKey(dateOnly("2026-08-04")), "2026-08-04");
  assert.equal(dateKey(addDays("2026-08-04", 1)), "2026-08-05");
  assert.throws(() => dateOnly("2026-02-30"), /valid calendar date/);
});
