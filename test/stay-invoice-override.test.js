const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../db_models/user.model");
const Property = require("../db_models/property.model");
const Reservation = require("../db_models/booking.model");
const Guest = require("../db_models/guest.model");
const Invoice = require("../db_models/invoice.model");
const Counter = require("../db_models/document-counter.model");
const Transaction = require("../db_models/financial-transaction.model");
const InventoryGuard = require("../db_models/inventory-guard.model");
const Audit = require("../db_models/booking-log.model");
const { buildAccommodationLines } = require("../services/financial-document.service");

const id = () => new mongoose.Types.ObjectId();
const query = value => ({ session() { return this; }, select() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

test("only the property Owner can intentionally create and issue an additional full-stay bill", async t => {
  process.env.JWT_SECRET = "invoice-override-test-secret";
  const users = ["owner", "admin", "finance", "outsider"].map(name => ({ _id: id(), name, role: "user" }));
  const [owner, admin, finance, outsider] = users;
  const propertyId = "invoice-override-test";
  const property = { property_id: propertyId, owner_id: owner._id, member_ids: [admin._id, finance._id],
    administrator_ids: [admin._id], staff_roles: [{ user_id: finance._id, role: "finance" }] };
  const guest = { _id: id(), name: "Guest" };
  const checkIn = new Date("2026-11-22T00:00:00.000Z"), checkOut = new Date("2026-11-24T00:00:00.000Z");
  const reservation = { _id: id(), property_id: propertyId, reservation_no: "RES-OVERRIDE", currency: "LKR", status: "confirmed",
    check_in: checkIn, check_out: checkOut, nights: 2, booker: { guest_profile_id: guest._id },
    rooms: [{ _id: id(), room_type_name: "Standard", effective_nightly_rate: 6500 }] };
  const original = new Invoice({ property_id: propertyId, reservation_id: reservation._id, reservation_no: reservation.reservation_no,
    currency: "LKR", invoice_no: "INV-ORIGINAL", guest_id: guest._id, billing_snapshot: { name: guest.name },
    stay_snapshot: { check_in: checkIn, check_out: checkOut, nights: 2 }, line_items: buildAccommodationLines(reservation), status: "paid" });
  await original.validate();
  const invoices = [original], transactions = [], logs = [];
  let sequence = 0;
  t.mock.method(User, "findById", value => query(users.find(user => String(user._id) === String(value))));
  t.mock.method(Property, "findOne", filter => query(filter.property_id === propertyId ? property : null));
  t.mock.method(InventoryGuard, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: work => work(), endSession: async () => {} }));
  t.mock.method(Reservation, "findOne", filter => query(filter.property_id === propertyId && String(filter._id) === String(reservation._id) ? reservation : null));
  t.mock.method(Guest, "findOne", filter => query(filter.property_id === propertyId && String(filter._id) === String(guest._id) ? guest : null));
  t.mock.method(Invoice, "find", filter => query(invoices.filter(invoice => invoice.property_id === filter.property_id && String(invoice.reservation_id) === String(filter.reservation_id) && invoice.status !== filter.status.$ne)));
  t.mock.method(Invoice, "findOne", filter => query(invoices.find(invoice => invoice.property_id === filter.property_id && String(invoice._id) === String(filter._id))));
  t.mock.method(Invoice, "create", async values => {
    const documents = values.map(value => new Invoice(value));
    for (const document of documents) await document.validate();
    invoices.push(...documents);
    return documents;
  });
  t.mock.method(Invoice.prototype, "save", async function () { await this.validate(); return this; });
  t.mock.method(Counter, "findOneAndUpdate", async () => ({ sequence: ++sequence }));
  t.mock.method(Transaction, "findOne", () => query(null));
  t.mock.method(Transaction, "create", async values => { transactions.push(...values); return values.map(value => ({ _id: id(), ...value })); });
  t.mock.method(Audit, "create", async values => { logs.push(...values); return values; });

  const { app } = require("../app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (actor, path, body, method = "POST") => fetch(`http://127.0.0.1:${server.address().port}/api/invoices${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ id: actor._id }, process.env.JWT_SECRET)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: propertyId, reservation_id: reservation._id, ...body })
  });
  const override = { invoice_id: original._id, reason: "Owner approved a separately billed stay.", confirmed: true };
  const request = { stay_override: override };
  assert.equal((await call(owner, "", {})).status, 409);
  for (const actor of [admin, finance, outsider]) assert.equal((await call(actor, "", request)).status, 403);
  assert.equal((await call(owner, "", { stay_override: { ...override, confirmed: false } })).status, 400);
  assert.equal((await call(owner, "", { stay_override: { ...override, reason: " " } })).status, 400);
  assert.equal((await call(owner, "", { stay_override: { ...override, invoice_id: id() } })).status, 409);
  assert.equal((await call(owner, "", { ...request, additional_line_items: [] })).status, 400);

  const created = await call(owner, "", request);
  assert.equal(created.status, 201, await created.clone().text());
  const { invoice: draft } = await created.json();
  assert.equal(draft.status, "draft");
  assert.equal(draft.grand_total, 13000);
  assert.equal(draft.stay_override.invoice_no, original.invoice_no);
  assert.equal(draft.stay_override.reason, override.reason);
  assert.equal(transactions.length, 0);
  assert.equal((await call(owner, "", request)).status, 409);
  assert.equal((await call(finance, `/${draft._id}`, { due_date: "2026-12-01" }, "PATCH")).status, 403);

  const issue = `/${draft._id}/issue`, confirmed = { confirm_stay_override: true };
  assert.equal((await call(admin, issue, confirmed)).status, 403);
  assert.equal((await call(finance, issue, confirmed)).status, 403);
  assert.equal((await call(owner, issue, {})).status, 400);
  reservation.rooms[0].effective_nightly_rate = 7000;
  assert.equal((await call(owner, issue, confirmed)).status, 409);
  reservation.rooms[0].effective_nightly_rate = 6500;
  const issued = await call(owner, issue, confirmed);
  assert.equal(issued.status, 200, await issued.clone().text());
  assert.equal((await issued.json()).invoice.status, "issued");
  assert.equal((await call(owner, issue, confirmed)).status, 409);
  assert.equal(original.status, "paid");
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].direction, "non_cash");
  assert.equal(transactions[0].amount, 13000);
  assert.deepEqual(logs.filter(log => log.entity_type === "invoice").map(log => log.action),
    ["invoice_stay_override_draft_created", "invoice_stay_override_issued"]);
  assert.ok(logs.every(log => log.actor.user_id === String(owner._id)));
});
