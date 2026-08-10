const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Refund = require("../db_models/refund.model");

function validRefund(overrides = {}) {
  return new Refund({
    property_id: " demo ",
    refund_no: " rf-2026-000001 ",
    invoice_id: new mongoose.Types.ObjectId(),
    invoice_no: " inv-2026-000001 ",
    payment_id: new mongoose.Types.ObjectId(),
    reservation_id: new mongoose.Types.ObjectId(),
    reservation_no: " res-test-001 ",
    guest_id: new mongoose.Types.ObjectId(),
    amount: 1000.005,
    currency: "lkr",
    refund_method: "Bank Transfer",
    reason: "The issued credit note created an overpayment.",
    ...overrides
  });
}

test("validates and normalizes a refund", async () => {
  const refund = validRefund();
  await refund.validate();

  assert.equal(refund.property_id, "demo");
  assert.equal(refund.refund_no, "RF-2026-000001");
  assert.equal(refund.invoice_no, "INV-2026-000001");
  assert.equal(refund.reservation_no, "RES-TEST-001");
  assert.equal(refund.currency, "LKR");
  assert.equal(refund.refund_method, "bank_transfer");
  assert.equal(refund.amount, 1000.01);
  assert.equal(refund.status, "pending");
});

test("rejects a zero refund and unsupported method", async () => {
  await assert.rejects(
    validRefund({ amount: 0 }).validate(),
    /greater than zero/
  );
  await assert.rejects(
    validRefund({ refund_method: "crypto" }).validate(),
    /not a valid enum value/
  );
});

test("requires a reason and original payment", async () => {
  await assert.rejects(
    validRefund({ reason: "" }).validate(),
    /Refund reason is required/
  );
  await assert.rejects(
    validRefund({ payment_id: undefined }).validate(),
    /Original payment ID is required/
  );
});
