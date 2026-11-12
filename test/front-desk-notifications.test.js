const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { notificationSources, listPropertyNotifications, notificationTypesForRole, canReadPropertyNotification, buildNotification } = require("../services/notification.service");
const NotificationReadState = require("../db_models/notification-read-state.model");
const User = require("../db_models/user.model");
const Property = require("../db_models/property.model");
const { HousekeepingActivity } = require("../db_models/housecleaning.model");
const makeId = () => String(new mongoose.Types.ObjectId());
const propertyId = "hotel-notifications";

function fixtures() {
  const reservationId = makeId();
  return Object.fromEntries(notificationSources.map((source, index) => [source.type, [{
    _id: makeId(), property_id: propertyId, created_at: new Date(Date.now() - 60_000 - index * 1000),
    reservation_id: reservationId, reservation_no: "RES-TEST-1", invoice_no: "INV-TEST-1", status: "posted",
    booking_source: "Direct", booker: { name: "Test Guest" }, billing_snapshot: { name: "Test Guest" },
    currency: "LKR", grand_total: 6500, amount: 500, payment_method: "cash"
  }]]));
}
function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$exists" in value) return (record[key] !== undefined) === value.$exists;
    if (value && typeof value === "object" && "$ne" in value) return record[key] !== undefined && record[key] !== value.$ne;
    return String(record[key]) === String(value);
  });
}
function query(value) {
  return { select() { return this; }, lean() { return this; }, sort() { if (Array.isArray(value)) value.sort((a, b) => b.created_at - a.created_at); return this; },
    limit(limit) { if (Array.isArray(value)) value = value.slice(0, limit); return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}
function mockSources(t, records) {
  const calls = [];
  t.mock.method(HousekeepingActivity, "find", () => query([]));
  for (const source of notificationSources) {
    t.mock.method(source.model, "find", (filter) => { calls.push({ type: source.type, filter }); return query(records[source.type].filter((record) => matches(record, filter))); });
    t.mock.method(source.model, "findOne", (filter) => { calls.push({ type: source.type, filter }); return query(records[source.type].find((record) => matches(record, filter)) || null); });
  }
  return calls;
}

test("staff roles add audience-scoped money requests while unknown roles fail closed", () => {
  assert.deepEqual(notificationTypesForRole("front_desk"), ["booking", "invoice", "payment", "money_request"]);
  for (const role of ["owner", "administrator"]) assert.equal(notificationTypesForRole(role).length, 12);
  for (const role of ["member", "demo"]) assert.equal(notificationTypesForRole(role).length, 10);
  assert.deepEqual(notificationTypesForRole("housekeeping"), ["housekeeping_request", "housekeeping_assignment", "money_request"]);
  for (const role of [null, undefined, "manager", "constructor"]) assert.deepEqual(notificationTypesForRole(role), []);
});

test("Front Desk filtering happens before queries, pagination and unread counting", async (t) => {
  const records = fixtures(), calls = mockSources(t, records);
  records.payment.push({ ...records.payment[0], _id: makeId(), status: "refunded" }, { ...records.payment[0], _id: makeId(), status: "voided" });
  records.booking.push({ ...records.booking[0], _id: makeId(), deleted_at: new Date() });
  records.invoice.push({ ...records.invoice[0], _id: makeId(), reservation_id: null });
  const feed = await listPropertyNotifications(propertyId, 100, "front_desk");
  assert.deepEqual(feed.map((item) => item.type), ["booking", "invoice", "payment"]);
  assert.deepEqual(calls.map((call) => call.type), ["money_request", "booking", "invoice", "payment"]);
  assert.ok(calls.every((call) => call.filter.property_id === propertyId));
  assert.deepEqual((await listPropertyNotifications(propertyId, 2, "front_desk")).map((item) => item.type), ["booking", "invoice"]);
  assert.equal((await listPropertyNotifications(propertyId, 30, "unexpected")).length, 0);
});

test("read actions cannot target hidden types, another property's records, deleted bookings or refunded payments", async (t) => {
  const records = fixtures(); mockSources(t, records);
  assert.equal(await canReadPropertyNotification(propertyId, `booking:${records.booking[0]._id}`, "front_desk"), true);
  assert.equal(await canReadPropertyNotification(propertyId, `credit_note:${records.credit_note[0]._id}`, "front_desk"), false);
  assert.equal(await canReadPropertyNotification("another-hotel", `booking:${records.booking[0]._id}`, "front_desk"), false);
  records.payment[0].status = "refunded";
  assert.equal(await canReadPropertyNotification(propertyId, `payment:${records.payment[0]._id}`, "front_desk"), false);
  assert.equal(await canReadPropertyNotification(propertyId, `payment:${records.payment[0]._id}`, "owner"), true);
  assert.equal(await canReadPropertyNotification(propertyId, "booking:not-an-id", "front_desk"), false);
});

test("guest payment notifications link to an allowed invoice or booking, never the financial ledger", () => {
  const source = notificationSources.find((item) => item.type === "payment");
  const record = fixtures().payment[0];
  assert.equal(buildNotification(source, record, propertyId).href, `/properties/${propertyId}/financials/invoices/INV-TEST-1`);
  record.invoice_no = "";
  assert.equal(buildNotification(source, record, propertyId).href, `/properties/${propertyId}/reservation/bookings/${record.reservation_id}`);
});

test("authenticated notification API filters Front Desk, protects read state and preserves hidden unread alerts after promotion", async (t) => {
  process.env.JWT_SECRET = "isolated-notification-access-test";
  const owner = { _id: makeId(), role: "user", name: "Owner", email: "owner@example.test" };
  const staff = { _id: makeId(), role: "user", name: "Front Desk", email: "staff@example.test" };
  const other = { _id: makeId(), role: "user", name: "Other", email: "other@example.test" };
  const property = new Property({ property_id: propertyId, owner_id: owner._id, member_ids: [staff._id, other._id],
    staff_roles: [{ user_id: staff._id, role: "front_desk" }, { user_id: other._id, role: "front_desk" }],
    info: { hotel_name: "Test Hotel", address: "Test Street", country_code: "LK", email: "hotel@example.test" } });
  t.mock.method(User, "findById", (id) => query([owner, staff, other].find((user) => user._id === String(id))));
  t.mock.method(Property, "findOne", (filter) => query(filter.property_id === propertyId ? property : null));
  const records = fixtures(); mockSources(t, records);
  const states = new Map();
  const stateKey = (filter) => `${filter.property_id}:${filter.user_id}`;
  t.mock.method(NotificationReadState, "findOne", (filter) => query(states.get(stateKey(filter)) || null));
  t.mock.method(NotificationReadState, "findOneAndUpdate", (filter, update) => {
    const key = stateKey(filter), state = states.get(key) || { ...filter, read_notification_ids: [], read_through_by_type: {} };
    for (const [field, value] of Object.entries(update.$set || {})) {
      if (field.startsWith("read_through_by_type.")) state.read_through_by_type[field.split(".")[1]] = value;
      else state[field] = value;
    }
    state.save = async () => { states.set(key, state); return state; };
    states.set(key, state); return query(state);
  });
  const { app } = require("../app");
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (user, suffix = "", method = "GET", hotel = propertyId) => fetch(`http://127.0.0.1:${server.address().port}/api/notifications${suffix}${method === "GET" ? `?property_id=${hotel}&role=owner&type=refund&limit=100` : ""}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ id: user._id }, process.env.JWT_SECRET)}`, "x-property-id": hotel, "x-user-id": owner._id, "Content-Type": "application/json" },
    ...(method !== "GET" ? { body: JSON.stringify({ property_id: hotel, role: "owner", types: ["refund"] }) } : {}) });
  const staffFeed = await (await request(staff)).json();
  assert.deepEqual(staffFeed.notifications.map((item) => item.type), ["booking", "invoice", "payment"]);
  assert.equal(staffFeed.unread_count, 3);
  assert.equal((await (await request(owner)).json()).notifications.length, 9);
  assert.equal((await request(staff, `/${encodeURIComponent(`refund:${records.refund[0]._id}`)}/read`, "PATCH")).status, 404);
  assert.equal(states.size, 0);
  const bookingId = `booking:${records.booking[0]._id}`;
  assert.equal((await request(staff, `/${encodeURIComponent(bookingId)}/read`, "PATCH")).status, 200);
  assert.equal((await (await request(staff)).json()).unread_count, 2);
  assert.equal((await (await request(other)).json()).unread_count, 3);
  assert.equal(states.has(`${propertyId}:${owner._id}`), false); // forged identity ignored
  assert.equal((await request(staff, "/read-all", "POST")).status, 200);
  const state = states.get(`${propertyId}:${staff._id}`);
  assert.deepEqual(Object.keys(state.read_through_by_type).sort(), ["booking", "invoice", "money_request", "payment"]);
  assert.equal(state.read_through_at, undefined);
  assert.equal((await (await request(staff)).json()).unread_count, 0);
  assert.equal((await (await request(owner)).json()).unread_count, 9);
  property.staff_roles = property.staff_roles.filter((entry) => String(entry.user_id) !== staff._id); // promoted to unrestricted member
  const promoted = await (await request(staff)).json();
  assert.equal(promoted.notifications.length, 9);
  assert.equal(promoted.unread_count, 6);
  assert.ok(promoted.notifications.filter((item) => !["booking", "invoice", "payment"].includes(item.type)).every((item) => !item.read));
  assert.equal((await request(staff, "", "GET", "another-hotel")).status, 403);
});

test("notification read-state stores per-category cutoffs without replacing the legacy global cutoff", async () => {
  const state = new NotificationReadState({ property_id: propertyId, user_id: "staff", read_through_by_type: { booking: "2026-10-27T00:00:00Z" } });
  await state.validate();
  assert.ok(state.read_through_by_type.get("booking") instanceof Date);
  assert.equal(state.read_through_at, undefined);
});
