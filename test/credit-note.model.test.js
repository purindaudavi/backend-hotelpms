const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const CreditNote = require("../db_models/credit-note.model");

function validCredit(overrides = {}) {
  return new CreditNote({
    property_id: " demo ",
    credit_note_no: " cn-2026-000001 ",
    invoice_id: new mongoose.Types.ObjectId(),
    invoice_no: " inv-2026-000001 ",
    reservation_id: new mongoose.Types.ObjectId(),
    reservation_no: " res-test-001 ",
    guest_id: new mongoose.Types.ObjectId(),
    guest_snapshot: {
      name: "Nimal Perera",
      email: "NIMAL@EXAMPLE.COM",
      phone: "+94 71 222 1188"
    },
    credit_date: "2026-08-06",
    currency: "lkr",
    reason_code: "rate_correction",
    reason: "The nightly room rate was entered incorrectly.",
    line_items: [
      {
        category: "accommodation",
        description: "Room rate correction",
        quantity: 2,
        unit_amount: 500,
        tax_amount: 100
      }
    ],
    ...overrides
  });
}

test("validates, normalizes, and calculates a credit note", async () => {
  const credit = validCredit();
  await credit.validate();

  assert.equal(credit.property_id, "demo");
  assert.equal(credit.credit_note_no, "CN-2026-000001");
  assert.equal(credit.invoice_no, "INV-2026-000001");
  assert.equal(credit.reservation_no, "RES-TEST-001");
  assert.equal(credit.currency, "LKR");
  assert.equal(credit.guest_snapshot.email, "nimal@example.com");
  assert.equal(credit.subtotal, 1000);
  assert.equal(credit.tax_total, 100);
  assert.equal(credit.total_credit, 1100);
  assert.equal(credit.line_items[0].total_amount, 1100);
});

test("rejects a credit note without lines", async () => {
  await assert.rejects(
    validCredit({ line_items: [] }).validate(),
    /At least one credit line is required/
  );
});

test("rejects unsupported credit reasons and zero-value credits", async () => {
  await assert.rejects(
    validCredit({ reason_code: "changed_mind" }).validate(),
    /not a valid enum value/
  );

  await assert.rejects(
    validCredit({
      line_items: [{
        category: "other",
        description: "Invalid zero credit",
        quantity: 1,
        unit_amount: 0
      }]
    }).validate(),
    /less than minimum allowed value/
  );
});
