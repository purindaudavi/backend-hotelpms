const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const FinancialTransaction = require("../db_models/financial-transaction.model");

function validTransaction(overrides = {}) {
  return new FinancialTransaction({
    property_id: " demo ",
    transaction_no: " tx-2026-000001 ",
    transaction_date: new Date("2026-08-13T08:00:00.000Z"),
    source_type: "Refund",
    source_id: new mongoose.Types.ObjectId(),
    source_number: " rf-2026-000001 ",
    direction: "Out",
    amount: 300.005,
    currency: "lkr",
    reservation_id: new mongoose.Types.ObjectId(),
    reservation_no: " res-test-001 ",
    room_numbers: [" 16 ", "16", "17"],
    description: "Refund returned to the guest.",
    ...overrides
  });
}

test("financial transaction normalizes refund money-out data", async () => {
  const transaction = validTransaction();
  await transaction.validate();

  assert.equal(transaction.property_id, "demo");
  assert.equal(transaction.transaction_no, "TX-2026-000001");
  assert.equal(transaction.source_type, "refund");
  assert.equal(transaction.source_number, "RF-2026-000001");
  assert.equal(transaction.direction, "out");
  assert.equal(transaction.accounting_effect, "neutral");
  assert.equal(transaction.amount, 300.01);
  assert.equal(transaction.currency, "LKR");
  assert.equal(transaction.reservation_no, "RES-TEST-001");
  assert.deepEqual(transaction.room_numbers, ["16", "17"]);
  assert.equal(transaction.status, "posted");
});

test("financial transaction accepts all supported financial sources", async () => {
  await assert.rejects(validTransaction({ amount: 0 }).validate(), /greater than zero/);
  await validTransaction({ source_type: "purchase" }).validate();
  await validTransaction({ source_type: "invoice", accounting_effect: "increase" }).validate();
  await assert.rejects(validTransaction({ source_type: "unknown" }).validate(), /not a valid enum value/);
});
