const test = require("node:test"), assert = require("node:assert/strict");
const express = require("express"), mongoose = require("mongoose");
const Purchase = require("../db_models/purchase.model");

function purchaseFixture() {
  return new Purchase({ property_id: "payment-method-test", purchase_no: "PUR-TEST-1", supplier_name: "Test Supplier", supplier_invoice_no: "SUP-1", purchase_date: "2026-11-06", due_date: "2026-11-06", amount: 100, currency: "LKR" });
}

test("supplier Other method details persist and are trimmed, bounded and compatible with historical records", async () => {
  const record = purchaseFixture(); record.status = "paid"; record.payment_method = "other";
  record.payment_method_details = "  Mobile wallet  "; await record.validate();
  assert.equal(record.toObject().payment_method_details, "Mobile wallet");
  const reloaded = new Purchase(record.toObject()); await reloaded.validate();
  assert.equal(reloaded.payment_method_details, "Mobile wallet");
  record.payment_method_details = "x".repeat(151);
  await assert.rejects(record.validate(), error => Boolean(error.errors.payment_method_details));
  const legacy = purchaseFixture(); legacy.status = "paid"; legacy.payment_method = "other";
  await legacy.validate(); assert.equal(legacy.payment_method_details, "");
});

test("supplier payment API validates supplied Other details before posting and preserves ordinary/legacy payments", async t => {
  let record, saved, postings;
  const reset = () => { record = purchaseFixture(); saved = null; postings = []; record.save = async () => { await record.validate(); saved = record.toObject(); return record; }; };
  reset();
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async work => work(), endSession: async () => {} }));
  t.mock.method(Purchase, "findOne", filter => { assert.equal(filter.property_id, "payment-method-test"); return { session: async () => record }; });
  t.mock.method(require("../services/financial-transaction.service"), "postFinancialTransaction", async input => { postings.push(input); return {}; });
  t.mock.method(require("../services/booking-audit.service"), "writeAuditLog", async () => {});
  const app = express(); app.use(express.json()); app.use("/purchases", require("../routes/purchases"));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const pay = body => fetch(`http://127.0.0.1:${server.address().port}/purchases/${record._id}/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ property_id: record.property_id, paid_at: "2026-11-06", ...body }) });
  for (const details of ["", "   ", null, {}, "x".repeat(151)]) {
    reset(); const response = await pay({ payment_method: "other", payment_method_details: details });
    assert.equal(response.status, 400); assert.match((await response.json()).message, /payment method/i);
    assert.equal(record.status, "to_be_paid"); assert.equal(saved, null); assert.equal(postings.length, 0);
  }
  reset();
  const response = await pay({ payment_method: "other", payment_method_details: "  Mobile wallet  ", payment_reference: "WALLET-123" });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.purchase.payment_method, "other"); assert.equal(result.purchase.payment_method_details, "Mobile wallet");
  assert.equal(saved.payment_method_details, "Mobile wallet"); assert.equal(saved.payment_reference, "WALLET-123");
  assert.equal(postings.length, 1); assert.equal(postings[0].sourceType, "supplier_payment");
  assert.equal(postings[0].amount, 100); assert.equal(postings[0].direction, "out");
  assert.match(postings[0].description, /Other - Mobile wallet/);
  for (const method of ["cash", "bank_transfer", "cheque"]) {
    reset(); const response = await pay({ payment_method: method, payment_method_details: "Stale form text" });
    assert.equal(response.status, 200); assert.equal(saved.payment_method, method); assert.equal(saved.payment_method_details, "");
  }
  reset();
  assert.equal((await pay({ payment_method: "other" })).status, 200);
  assert.equal(saved.payment_method_details, ""); // Original Financials client remains supported.
});
