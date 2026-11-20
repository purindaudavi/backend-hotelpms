const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { buildCheckoutReview, getCheckoutReview, assertCheckoutSettled } = require("../services/checkout-review.service");
const Invoice = require("../db_models/invoice.model");
const Payment = require("../db_models/reservation-payment.model");
const Credit = require("../db_models/credit-note.model");
const Refund = require("../db_models/refund.model");

const stay = (fields = {}) => ({ _id: "stay-one", property_id: "hotel-one", reservation_no: "RES-1", currency: "LKR", status: "checked_in",
  booker: { name: "Test Guest" }, financial_summary: { grand_total: 1000, paid_total: 999999 }, ...fields });
const invoice = (fields = {}) => ({ _id: "inv-one", invoice_no: "INV-1", currency: "LKR", status: "issued", grand_total: 1000,
  paid_amount: 999999, credited_amount: 999999,
  line_items: [{ source_type: "accommodation", description: "Room 101", quantity: 1, unit_price: 1000 }], ...fields });
const payment = (fields = {}) => ({ invoice_id: "inv-one", currency: "LKR", amount: 1000, status: "posted", ...fields });

test("checkout requires settlement from real records, not forged/cached paid totals", () => {
  const review = buildCheckoutReview(stay(), { invoices: [invoice()] });
  assert.equal(review.can_check_out, false);
  assert.equal(review.totals_by_currency[0].balance_due, 1000);
  assert.equal(review.invoices[0].lines[0].amount, 1000);
  assert.throws(() => assertCheckoutSettled(review), { statusCode: 409, code: "CHECKOUT_NOT_SETTLED" });
  const paid = buildCheckoutReview(stay(), { invoices: [invoice()], payments: [payment()] });
  assert.equal(paid.can_check_out, true);
  assert.equal(paid.totals_by_currency[0].total, 1000); // accommodation is not counted twice
  assert.doesNotThrow(() => assertCheckoutSettled(paid));
});

test("extra service invoices and currencies must each be settled; surplus never offsets another invoice", () => {
  const invoices = [invoice(), invoice({ _id: "service", invoice_no: "INV-2", currency: "USD", grand_total: 25 })];
  let review = buildCheckoutReview(stay(), { invoices, payments: [payment({ amount: 2000 })] });
  assert.equal(review.can_check_out, false);
  assert.equal(review.totals_by_currency.find((group) => group.currency === "USD").balance_due, 25);
  assert.equal(review.totals_by_currency.find((group) => group.currency === "LKR").refund_due, 1000);
  review = buildCheckoutReview(stay(), { invoices, payments: [payment(), payment({ invoice_id: "service", currency: "USD", amount: 25 })] });
  assert.equal(review.can_check_out, true);
  const sameCurrency = buildCheckoutReview(stay(), { invoices: [invoice(), invoice({ _id: "service", grand_total: 25 })], payments: [payment({ amount: 1025 })] });
  assert.equal(sameCurrency.totals_by_currency[0].balance_due, 25);
});

test("an issued owner override is collectible but cannot cover unbilled stay charges", () => {
  const override = invoice({ _id: "override", invoice_no: "INV-2", stay_override: { invoice_id: "inv-one" } });
  const invoices = [invoice(), override];
  assert.equal(buildCheckoutReview(stay(), { invoices, payments: [payment()] }).totals_by_currency[0].balance_due, 1000);
  const data = { invoices, payments: [payment(), payment({ invoice_id: "override" })] };
  assert.equal(buildCheckoutReview(stay(), data).can_check_out, true);
  const extended = buildCheckoutReview(stay({ financial_summary: { grand_total: 2000 } }), data);
  assert.equal(extended.can_check_out, false);
  assert.match(extended.issues[0], /exceeds linked invoice totals by LKR 1000/);
});

test("only issued credits, completed refunds and non-voided payments affect settlement", () => {
  const data = { invoices: [invoice()], payments: [payment({ amount: 700 }), payment({ amount: 10000, status: "voided" })],
    credits: [{ invoice_id: "inv-one", currency: "LKR", total_credit: 300, status: "draft" }] };
  assert.equal(buildCheckoutReview(stay(), data).can_check_out, false);
  data.credits[0].status = "issued";
  assert.equal(buildCheckoutReview(stay(), data).can_check_out, true);
  data.refunds = [{ invoice_id: "inv-one", currency: "LKR", amount: 100, status: "pending" }];
  assert.equal(buildCheckoutReview(stay(), data).can_check_out, true);
  data.refunds[0].status = "completed";
  assert.equal(buildCheckoutReview(stay(), data).invoices[0].balance_due, 100);
  data.payments.push(payment({ amount: 50, status: "refunded" }));
  assert.equal(buildCheckoutReview(stay(), data).invoices[0].balance_due, 150);
});

test("draft charges, changed stay totals and unallocated deposits require reconciliation", () => {
  for (const data of [
    { invoices: [invoice({ status: "draft" })], payments: [payment()] },
    { invoices: [invoice({ grand_total: 500 })], payments: [payment({ amount: 500 })] },
    { invoices: [invoice()], payments: [payment(), payment({ invoice_id: undefined, amount: 50 })] },
    { invoices: [invoice({ status: "voided" })], payments: [payment()] }
  ]) assert.equal(buildCheckoutReview(stay(), data).can_check_out, false);
});

test("legacy stays without invoices use payment records and keep currencies distinct", () => {
  assert.equal(buildCheckoutReview(stay()).can_check_out, false);
  assert.equal(buildCheckoutReview(stay(), { payments: [payment({ invoice_id: undefined })] }).can_check_out, true);
  assert.equal(buildCheckoutReview(stay(), { payments: [payment({ invoice_id: undefined, currency: "USD" })] }).can_check_out, false);
  assert.equal(buildCheckoutReview(stay({ financial_summary: { grand_total: 0 } })).can_check_out, true);
  assert.equal(buildCheckoutReview(stay({ status: "confirmed" }), { payments: [payment()] }).can_check_out, false);
});

test("wrong-currency and invalid financial records fail closed", () => {
  assert.equal(buildCheckoutReview(stay(), { invoices: [invoice()], payments: [payment({ currency: "USD" })] }).can_check_out, false);
  assert.equal(buildCheckoutReview(stay(), { invoices: [invoice()], payments: [payment({ amount: NaN })] }).can_check_out, false);
  assert.equal(buildCheckoutReview(stay(), { invoices: [invoice()], credits: [{ invoice_id: "inv-one", currency: "LKR", status: "issued", total_credit: 1500 }] }).can_check_out, false);
});

function query(value, onSession = () => {}) {
  return { sort() { return this; }, lean() { return this; }, session(session) { onSession(session); return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}

test("review scopes all billing queries to the property and reservation, using the caller's transaction", async (t) => {
  const session = {}, record = stay();
  for (const [Model, value] of [[Invoice, [invoice()]], [Payment, [payment()]], [Credit, []], [Refund, []]]) {
    t.mock.method(Model, "find", (filter) => {
      assert.equal(filter.property_id, record.property_id);
      if (Model === Invoice) assert.equal(filter.reservation_id, record._id);
      else { assert.equal(filter.$or[0].reservation_id, record._id); assert.deepEqual(filter.$or[1].invoice_id.$in, ["inv-one"]); }
      return query(value, (actual) => assert.equal(actual, session));
    });
  }
  assert.equal((await getCheckoutReview(record, session)).can_check_out, true);
});

test("HTTP checkout rechecks stale previews, blocks every role and leaves rooms untouched until settlement", async (t) => {
  const express = require("express");
  const Reservation = require("../db_models/booking.model");
  const Guard = require("../db_models/inventory-guard.model");
  const Audit = require("../db_models/booking-log.model");
  const { authorizePropertyRequest } = require("../services/property-permissions.service");
  const record = { ...stay({ _id: new mongoose.Types.ObjectId() }), rooms: [], check_in: new Date("2026-10-25"), check_out: new Date("2026-10-27"),
    toObject() { return { ...this }; }, async save() { return this; } };
  let payments = [], guardTouched = false;
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Guard, "updateOne", async (_filter, _update, options) => { if (options.session) guardTouched = true; return { matchedCount: 1 }; });
  t.mock.method(Reservation, "findOne", (filter) => query(filter.property_id === "hotel-one" && String(filter._id) === String(record._id) ? record : null));
  t.mock.method(Invoice, "find", () => query([invoice()]));
  t.mock.method(Payment, "find", () => query(payments, (actual) => { if (actual) { assert.equal(actual, session); assert.ok(guardTouched); } }));
  t.mock.method(Credit, "find", () => query([])); t.mock.method(Refund, "find", () => query([]));
  const audit = [];
  t.mock.method(Audit, "create", async (values) => { audit.push(...values); return values; });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.propertyRole = req.get("x-test-role") || "front_desk"; authorizePropertyRequest(req, res, next); });
  app.use("/bookings", require("../routes/bookings"));
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const path = `/bookings/reservations/${record._id}`;
  const request = (suffix, role = "front_desk", property = "hotel-one", method = "GET") => fetch(`http://127.0.0.1:${server.address().port}${path}/${suffix}`, {
    method, headers: { "x-property-id": property, "x-test-role": role, "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ balance_due: 0, force: true }) } : {}) });
  assert.equal((await (await request("checkout-review")).json()).can_check_out, false);
  for (const role of ["front_desk", "owner", "administrator"]) {
    const response = await request("check-out", role, "hotel-one", "POST");
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "CHECKOUT_NOT_SETTLED");
    assert.equal(record.status, "checked_in"); assert.equal(audit.length, 0);
  }
  assert.equal((await request("checkout-review", "front_desk", "other-hotel")).status, 404);
  payments = [payment()];
  assert.equal((await (await request("checkout-review")).json()).can_check_out, true);
  payments = []; // another user voided payment after the preview
  assert.equal((await request("check-out", "front_desk", "hotel-one", "POST")).status, 409);
  payments = [payment()];
  assert.equal((await request("check-out", "front_desk", "hotel-one", "POST")).status, 200);
  assert.equal(record.status, "checked_out"); assert.equal(audit[0].action, "reservation_checked_out");
  assert.equal(record.financial_summary.paid_total, 1000);
});
