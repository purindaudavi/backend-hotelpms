const assert = require("node:assert/strict");
const test = require("node:test");
const Invoice = require("../db_models/invoice.model");
const CreditNote = require("../db_models/credit-note.model");
const { getStayExtensionPlan, sameExtension, canIssueStayExtension, assertBilledStayDatesCanChange } = require("../services/stay-extension-invoice.service");

const day = (value) => new Date(`2026-11-${value}T00:00:00.000Z`);
function reservation(checkOut = 24) {
  return {
    _id: "booking", reservation_no: "RES-TEST", status: "confirmed", currency: "LKR",
    check_in: day(22), check_out: day(checkOut), booker: { name: "Test Guest" },
    rooms: [{ _id: "room-line", room_type_name: "Standard", room_number: "101", effective_nightly_rate: 6500 }],
    financial_summary: { grand_total: (checkOut - 22) * 6500 }
  };
}

function bill({ id = "original", from = 22, to = 23, status = "issued", extensionOf } = {}) {
  return {
    _id: id, status, currency: "LKR", grand_total: (to - from) * 6500, extension_of: extensionOf,
    stay_snapshot: { check_in: day(from), check_out: day(to) },
    line_items: [{ source_type: "accommodation", source_id: "room-line", total_amount: (to - from) * 6500 }]
  };
}

test("an issued or paid first night produces an extra-night-only draft quote", () => {
  const original = bill({ status: "paid" });
  const plan = getStayExtensionPlan(reservation(), [original]);
  assert.deepEqual(plan.preview, {
    reservation_id: "booking", reservation_no: "RES-TEST", guest_name: "Test Guest",
    from_date: "2026-11-23", to_date: "2026-11-24", nights: 1, currency: "LKR", amount: 6500
  });
  assert.equal(plan.lines[0].quantity, 1);
  assert.deepEqual(plan.lines[0].service_date, day(23));
  assert.equal(plan.original, original);
});

test("drafts cover only their own dates, including when the same booking is extended again", () => {
  const original = bill();
  const draft = bill({ id: "draft", from: 23, to: 24, status: "draft", extensionOf: original._id });
  const firstQuote = getStayExtensionPlan(reservation(), [original]).preview;
  assert.equal(sameExtension(draft, firstQuote), true);
  assert.equal(getStayExtensionPlan(reservation(), [original, draft]), null);
  assert.equal(canIssueStayExtension(reservation(), [original, draft], draft), true);
  assert.equal(canIssueStayExtension(reservation(23), [original, draft], draft), false);
  const next = getStayExtensionPlan(reservation(26), [draft, original]);
  assert.equal(next.preview.from_date, "2026-11-24");
  assert.equal(next.preview.nights, 2);
  assert.equal(next.preview.amount, 13000);
  draft.status = "voided";
  assert.deepEqual(getStayExtensionPlan(reservation(), [original, draft]).preview, firstQuote);
});

test("requests outside a consistent, billable extension cannot create an extra charge", () => {
  const stay = reservation();
  assert.equal(getStayExtensionPlan(stay, [bill({ status: "draft" })]), null);
  assert.equal(getStayExtensionPlan(stay, [bill(), bill({ id: "another-full-stay", to: 24 })]), null);
  assert.equal(getStayExtensionPlan({ ...stay, status: "cancelled" }, [bill()]), null);
  assert.equal(getStayExtensionPlan({ ...stay, is_day_room: true }, [bill()]), null);
  assert.equal(getStayExtensionPlan({ ...stay, financial_summary: { grand_total: 12500 } }, [bill()]), null);
});

test("a changed nightly average keeps the original charge and bills the difference for the extension", () => {
  const stay = reservation();
  stay.rooms[0].effective_nightly_rate = 7000;
  stay.financial_summary.grand_total = 14000;
  const plan = getStayExtensionPlan(stay, [bill()]);
  assert.equal(plan.preview.amount, 7500);
  assert.equal(plan.lines[0].unit_price, 7500);
  assert.deepEqual(plan.lines[0].service_date, day(23));
});

test("owner override invoices do not consume dates in the normal extension workflow", () => {
  const original = bill();
  const override = { ...bill({ id: "override", to: 24 }), stay_override: { invoice_id: original._id } };
  const plan = getStayExtensionPlan(reservation(), [original, override]);
  assert.equal(plan.preview.amount, 6500);
  const draft = bill({ id: "extension", from: 23, to: 24, status: "draft", extensionOf: original._id });
  assert.equal(canIssueStayExtension(reservation(), [original, override, draft], draft), true);
});

test("shortening after an issued extension requires the applicable credit and completed refund", async t => {
  const before = reservation(), shorter = { ...reservation(23), property_id: "hotel-test" }, session = {};
  const original = bill();
  const extension = bill({ id: "extension", from: 23, to: 24, extensionOf: original._id });
  extension.invoice_no = "INV-EXTRA";
  const find = t.mock.method(Invoice, "find", filter => {
    assert.equal(filter.property_id, shorter.property_id);
    assert.equal(filter.reservation_id, shorter._id);
    return { session(actual) { assert.equal(actual, session); return [original, extension]; } };
  });
  await assertBilledStayDatesCanChange(before, before, session);
  await assertBilledStayDatesCanChange(before, reservation(25), session);
  assert.equal(find.mock.callCount(), 0);
  extension.status = "draft";
  await assertBilledStayDatesCanChange(before, shorter, session);
  extension.status = "issued";
  await assert.rejects(assertBilledStayDatesCanChange(before, shorter, session), {
    statusCode: 409, code: "BILLED_STAY_DATES", message: /INV-EXTRA.*LKR 6500\.00/
  });
  extension.credited_amount = 6500;
  extension.paid_amount = 6500;
  extension.status = "credited";
  await assert.rejects(assertBilledStayDatesCanChange(before, shorter, session), /outstanding refund of LKR 6500\.00/);
  extension.paid_amount = 0;
  await assertBilledStayDatesCanChange(before, shorter, session);
  const next = getStayExtensionPlan(before, [original, extension]);
  assert.equal(next.preview.amount, 6500);
  assert.equal(sameExtension(extension, next.preview), false);
});

test("when shortening part of an invoiced stay, only credits attributable to the stay can clear the removed charges", async t => {
  const before = reservation(25), after = { ...reservation(), property_id: "hotel-test" };
  const invoice = bill({ to: 25 });
  invoice.invoice_no = "INV-STAY";
  invoice.line_items[0]._id = "room";
  invoice.line_items.push({ _id: "transfer", source_type: "transport", total_amount: 6500 });
  invoice.grand_total += 6500;
  invoice.credited_amount = 6500;
  let credits = [{ line_items: [{ invoice_line_id: "transfer", total_amount: 6500 }] }];
  t.mock.method(Invoice, "find", () => ({ session: () => [invoice] }));
  t.mock.method(CreditNote, "find", filter => {
    assert.equal(filter.status, "issued");
    return { session: () => credits };
  });
  await assert.rejects(assertBilledStayDatesCanChange(before, after), /INV-STAY.*LKR 6500\.00/);
  credits = [{ line_items: [{ invoice_line_id: "room", total_amount: 6500 }] }];
  await assertBilledStayDatesCanChange(before, after);
});

test("reservation update preserves the saved departure until the billed extension is credited", async t => {
  const express = require("express");
  const mongoose = require("mongoose");
  const Reservation = require("../db_models/booking.model");
  const InventoryGuard = require("../db_models/inventory-guard.model");
  const RoomType = require("../db_models/rooms.model");
  const BusinessBlock = require("../db_models/business-block.model");
  const { RatePlan } = require("../db_models/rates.model");
  const { MealAllocation } = require("../db_models/property.model");
  const Audit = require("../db_models/booking-log.model");
  const original = bill();
  const extension = { ...bill({ id: "extension", from: 23, to: 24, extensionOf: original._id }), invoice_no: "INV-EXTRA" };
  const session = { withTransaction: async work => work(), endSession: async () => {} };
  const reservationId = new mongoose.Types.ObjectId();
  let savedCheckout = day(24), inventoryChecks = 0, writes = 0;
  const query = value => ({ sort() { return this; }, session(actual) { if (actual) assert.equal(actual, session); return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(InventoryGuard, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(Reservation, "findOne", filter => query(filter.property_id === "hotel-test" && String(filter._id) === String(reservationId) ? {
    ...reservation(), _id: reservationId, property_id: "hotel-test", check_out: savedCheckout, rooms: [],
    async validate() {}, toObject() { return { ...this }; },
    async save(options) { assert.equal(options.session, session); savedCheckout = this.check_out; writes++; return this; }
  } : null));
  t.mock.method(Reservation, "find", () => query([]));
  t.mock.method(Invoice, "find", () => query([original, extension]));
  t.mock.method(Invoice, "findOne", () => query(null));
  t.mock.method(RoomType, "find", () => { inventoryChecks++; return query([]); });
  t.mock.method(BusinessBlock, "find", () => query([]));
  t.mock.method(RatePlan, "find", () => query([]));
  t.mock.method(MealAllocation, "find", () => query([]));
  t.mock.method(Audit, "create", async values => values);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.propertyRole = req.get("x-test-role"); next(); });
  app.use("/bookings", require("../routes/bookings"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const update = role => fetch(`http://127.0.0.1:${server.address().port}/bookings/reservations/${reservationId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "x-test-role": role, "x-property-id": "hotel-test" },
    body: JSON.stringify({ check_out: day(23), financial_summary: { grand_total: 6500 } })
  });
  for (const role of ["front_desk", "administrator", "owner"]) {
    const rejected = await update(role);
    assert.equal(rejected.status, 409, await rejected.clone().text());
    assert.equal((await rejected.json()).code, "BILLED_STAY_DATES");
  }
  assert.deepEqual(savedCheckout, day(24));
  assert.equal(inventoryChecks, 0);
  assert.equal(writes, 0);

  extension.status = "credited";
  extension.credited_amount = 6500;
  const updated = await update("owner");
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal(savedCheckout, day(23).toISOString());
  assert.equal(inventoryChecks, 1);
  assert.equal(writes, 1);
});
