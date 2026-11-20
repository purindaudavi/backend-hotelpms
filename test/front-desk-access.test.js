const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { authorizePropertyRequest, permissionsForRole } = require("../services/property-permissions.service");
const { propertyRole } = require("../services/property-access.service");
const { enforceFrontDeskBookingRules, enforceFrontDeskPaymentCurrency } = require("../services/front-desk-booking.service");
const Property = require("../db_models/property.model");
const User = require("../db_models/user.model");
const RoomType = require("../db_models/rooms.model");
const { RatePlan } = require("../db_models/rates.model");
const Reservation = require("../db_models/booking.model");
const Invoice = require("../db_models/invoice.model");
const Guest = require("../db_models/guest.model");
const AuditLog = require("../db_models/booking-log.model");

test("Front Desk API policy explicitly allows operations and denies privileged paths", () => {
  const allowed = [
    ["GET", "/rooms"], ["GET", "/rates"], ["POST", "/rates/quote"], ["GET", "/housekeeping"],
    ["POST", "/housekeeping/rooms/room-one/assign"], ["GET", "/bookings/reservations/booking-one/checkout-review"],
    ["POST", "/housekeeping/rooms/room-one/request"],
    ["GET", "/properties/hotel-one"], ["GET", "/properties/hotel-one/theme"], ["GET", "/properties/hotel-one/my-access"],
    ["GET", "/guests"], ["POST", "/guests"], ["PATCH", "/guests/guest-one"],
    ["POST", "/bookings/reservations"], ["PATCH", "/bookings/reservations/booking-one"],
    ...["confirm", "check-in", "check-out", "cancel", "no-show", "room-moves", "room-reassignment", "room-swap", "occupants", "attachments", "payments"].map((action) => ["POST", `/bookings/reservations/booking-one/${action}`]),
    ["GET", "/bookings/reservations/booking-one/attachments/file-one/file"],
    ["GET", "/invoices"], ["GET", "/invoices/invoice-one"], ["POST", "/invoices/invoice-one/payments"],
    ["GET", "/notifications"], ["PATCH", "/notifications/booking:record-one/read"], ["POST", "/notifications/read-all"],
    ["POST", "/mail/confirmation"]
  ];
  const denied = [
    ["GET", "/reports/dashboard"], ["POST", "/reports/generate"], ["GET", "/reports/history"],
    ["GET", "/withdrawals"], ["GET", "/purchases"], ["GET", "/expenses"], ["GET", "/transactions"],
    ["GET", "/receivables"], ["GET", "/financial-targets"], ["GET", "/credits"], ["GET", "/refunds"],
    ["GET", "/night-audit"], ["GET", "/channel-requests"], ["POST", "/mail/general"], ["POST", "/notifications"],
    ["POST", "/rooms"], ["PATCH", "/rooms/type-one"], ["POST", "/rates"], ["PUT", "/rates/rate-one/daily-rates"],
    ["POST", "/housekeeping/rooms/room-one/complete"], ["POST", "/housekeeping/attendants"],
    ["POST", "/housekeeping/rooms/room-one/start"], ["POST", "/housekeeping/rooms/room-one/inspect"], ["PATCH", "/housekeeping/attendants/attendant-one"],
    ["POST", "/travel-agents"], ["GET", "/travel-agents/agent-one/performance"], ["DELETE", "/guests/guest-one"],
    ["GET", "/properties/hotel-one/access"], ["PATCH", "/properties/hotel-one/info"], ["POST", "/properties/hotel-one/images"],
    ["POST", "/invoices"], ["PATCH", "/invoices/invoice-one"], ["POST", "/invoices/invoice-one/issue"], ["POST", "/invoices/invoice-one/void"],
    ["POST", "/invoices/invoice-one/payments/payment-one/void"], ["POST", "/bookings/reservations/booking-one/payments/payment-one/void"],
    ["DELETE", "/bookings/reservations/booking-one"], ["POST", "/bookings/business-blocks"], ["POST", "/integrations/test-channel/sync"]
  ];
  function check([method, path], expected, body = {}) {
    let passed = false, status;
    const res = { status(value) { status = value; return this; }, json() { return this; } };
    authorizePropertyRequest({ propertyRole: "front_desk", method, path, body }, res, () => { passed = true; });
    assert.equal(passed, expected, `${method} ${path}`);
    if (!expected) assert.equal(status, 403);
  }
  allowed.forEach((entry) => check(entry, true)); denied.forEach((entry) => check(entry, false));
  check(["POST", "/bookings/reservations/booking-one/payments"], false, { status: "refunded" });
  check(["POST", "/invoices/invoice-one/payments"], false, { status: "voided" });
  assert.ok(!permissionsForRole("front_desk").includes("staff.manage"));
  for (const role of ["finance", "housekeeping"]) {
    for (const action of ["room-reassignment", "room-swap"]) {
      assert.equal(authorizePropertyRequest({ propertyRole: role, method: "POST", path: `/bookings/reservations/booking-one/${action}` },
        { status: (status) => ({ json: () => status }) }, () => 200), 403);
    }
  }
});

function booking() {
  return { property_id: "hotel-one", check_in: new Date("2026-11-01T00:00:00Z"), check_out: new Date("2026-11-03T00:00:00Z"), is_day_room: false,
    rate_plan_id: "plan-one", currency: "LKR", meal_plan: "Room Only", refundable: true, cancellation_policy: "Standard terms",
    financial_summary: { room_total: 1, grand_total: 1, paid_total: 999999 },
    rooms: [{ _id: "line-one", room_type_id: "type-one", physical_room_id: "room-one", adults: 2, children: 0, rate_plan_id: "plan-one", currency: "LKR", meal_plan: "Room Only",
      original_nightly_rate: 6500, effective_nightly_rate: 6500, is_complimentary: false, complimentary_reason: "", requires_manager_approval: false }] };
}
const quote = async () => ({ average_nightly_rate: 6500, currency: "LKR", meal_plan: "Room Only", rate_plan_name: "Standard Room Only", refundable: true, cancellation_policy: "Standard terms" });

test("Front Desk booking totals are server calculated, including day use; payment summaries cannot be forged", async () => {
  const reservation = booking();
  await enforceFrontDeskBookingRules({ role: "front_desk", reservation, quote });
  assert.equal(reservation.financial_summary.grand_total, 13000);
  assert.equal(reservation.financial_summary.paid_total, 0);
  assert.equal(reservation.rate_plan_name, "Standard Room Only");
  const previous = structuredClone(reservation);
  reservation.financial_summary = { grand_total: 1, paid_total: 999999 };
  reservation.rooms[0].physical_room_id = "room-two";
  reservation.refundable = false;
  await enforceFrontDeskBookingRules({ role: "front_desk", reservation, previous, quote: () => { throw Error("should preserve historical quote"); } });
  assert.equal(reservation.financial_summary.grand_total, 13000);
  assert.equal(reservation.financial_summary.paid_total, 0);
  assert.equal(reservation.refundable, true);
  const day = booking(); day.is_day_room = true; day.check_out = day.check_in;
  await enforceFrontDeskBookingRules({ role: "front_desk", reservation: day, quote });
  assert.equal(day.financial_summary.grand_total, 6500);
});

test("Front Desk cannot override prices, grant FOC or reprice an existing approved override", async () => {
  for (const fields of [{ effective_nightly_rate: 10 }, { original_nightly_rate: 10 }, { is_complimentary: true }, { requires_manager_approval: true }]) {
    const reservation = booking(); Object.assign(reservation.rooms[0], fields);
    await assert.rejects(enforceFrontDeskBookingRules({ role: "front_desk", reservation, quote }), { statusCode: 403 });
  }
  const previous = booking(); previous.rooms[0].effective_nightly_rate = 6000; previous.financial_summary = { room_total: 12000, grand_total: 12000, paid_total: 1000 };
  const unchanged = structuredClone(previous);
  await enforceFrontDeskBookingRules({ role: "front_desk", reservation: unchanged, previous, quote: () => { throw Error("must preserve approved override"); } });
  const changed = structuredClone(previous); changed.rooms[0].effective_nightly_rate = 6500;
  await assert.rejects(enforceFrontDeskBookingRules({ role: "front_desk", reservation: changed, previous, quote }), { statusCode: 403 });
  changed.rooms[0].effective_nightly_rate = 6000; changed.check_out = new Date("2026-11-04");
  await assert.rejects(enforceFrontDeskBookingRules({ role: "front_desk", reservation: changed, previous, quote }), { statusCode: 403 });
  const owner = booking(); owner.rooms[0].is_complimentary = true;
  await enforceFrontDeskBookingRules({ role: "owner", reservation: owner, quote: () => { throw Error("owner workflow is unchanged"); } });
});

test("Front Desk repricing uses the quote restrictions and database session", async () => {
  const reservation = booking(), previous = structuredClone(reservation), session = {};
  reservation.check_out = new Date("2026-11-04"); previous.financial_summary = { tax_total: 100, discount_total: 20, extra_total: 10, paid_total: 500 };
  await enforceFrontDeskBookingRules({ role: "front_desk", reservation, previous, session, quote: async (input) => { assert.equal(input.session, session); return quote(); } });
  assert.equal(reservation.financial_summary.grand_total, 19590);
  assert.equal(reservation.financial_summary.paid_total, 500);
  await assert.rejects(enforceFrontDeskBookingRules({ role: "front_desk", reservation: booking(), quote: async () => { throw Object.assign(Error("Stop sell"), { statusCode: 409 }); } }), /Stop sell/);
});

test("Front Desk payments cannot credit a different currency", () => {
  assert.doesNotThrow(() => enforceFrontDeskPaymentCurrency("front_desk", "lkr", "LKR"));
  assert.doesNotThrow(() => enforceFrontDeskPaymentCurrency("front_desk", undefined, "LKR"));
  assert.throws(() => enforceFrontDeskPaymentCurrency("front_desk", "USD", "LKR"), { statusCode: 400 });
});

test("Front Desk pricing works with actual reservation subdocuments and historical edit snapshots", async () => {
  const raw = booking();
  raw.rooms[0]._id = new mongoose.Types.ObjectId();
  raw.rooms[0].room_type_id = new mongoose.Types.ObjectId();
  raw.rooms[0].physical_room_id = new mongoose.Types.ObjectId();
  raw.rooms[0].room_type_name = "Standard Room";
  const reservation = new Reservation({ ...raw, reservation_no: "FD-TEST", booker: { name: "Test Guest", phone: "0771234567", email: "guest@example.test", country: "Sri Lanka" } });
  await enforceFrontDeskBookingRules({ role: "front_desk", reservation, quote });
  await reservation.validate();
  assert.equal(reservation.financial_summary.grand_total, 13000);
  const previous = reservation.toObject({ virtuals: false });
  reservation.booker.name = "Updated Guest";
  await enforceFrontDeskBookingRules({ role: "front_desk", reservation, previous, quote: () => { throw Error("saved context should match"); } });
  await reservation.validate();
  assert.equal(reservation.financial_summary.grand_total, 13000);
});

function query(value) {
  return { select() { return this; }, populate() { return this; }, lean() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}

test("HTTP property role assignment, restricted reads/writes, role changes and revocation", async (t) => {
  process.env.JWT_SECRET = "isolated-front-desk-access-test";
  const makeUser = (name) => ({ _id: new mongoose.Types.ObjectId(), role: "user", name, email: `${name}@example.test` });
  const owner = makeUser("owner"), admin = makeUser("admin"), staff = makeUser("frontdesk"), users = [owner, admin, staff];
  let property = new Property({ property_id: "hotel-front-desk", owner_id: owner._id, member_ids: [admin._id], administrator_ids: [admin._id],
    info: { hotel_name: "Test Hotel", address: "Test Street", country_code: "LK", email: "hotel@example.test" } }).toObject();
  t.mock.method(User, "findById", (id) => query(users.find((user) => String(user._id) === String(id))));
  t.mock.method(User, "findOne", ({ email }) => query(users.find((user) => user.email === email)));
  t.mock.method(User, "find", ({ _id }) => query(users.filter((user) => _id.$in.some((id) => String(id) === String(user._id)))));
  t.mock.method(Property, "findOne", ({ property_id }) => query(property_id === property.property_id ? new Property(property) : null));
  t.mock.method(Property, "find", () => query([new Property(property)]));
  t.mock.method(Property.prototype, "save", async function () { await this.validate(); property = this.toObject(); return this; });
  for (const Model of [RoomType, RatePlan, Reservation, Invoice, Guest]) t.mock.method(Model, "find", () => query([]));
  for (const Model of [Reservation, Invoice, Guest]) t.mock.method(Model, "countDocuments", () => query(0));
  t.mock.method(AuditLog, "create", async (values) => values);
  t.mock.method(require("../db_models/inventory-guard.model"), "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (work) => work(), inTransaction: () => true, endSession: async () => {} }));
  const { app } = require("../app");
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (user, path, method = "GET", body) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`, "x-property-id": property.property_id },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const access = `/properties/${property.property_id}/access`;
  assert.equal((await request(admin, access, "POST", { email: staff.email, role: "front_desk" })).status, 201);
  assert.equal(propertyRole(property, staff), "front_desk");
  assert.equal((await (await request(staff, `/properties/${property.property_id}/my-access`)).json()).role, "front_desk");
  for (const path of ["/rooms", "/rates", "/bookings/reservations", "/invoices", "/guests"]) assert.equal((await request(staff, path)).status, 200, path);
  for (const [path, method, body] of [
    ["/reports/dashboard", "GET"], ["/expenses", "GET"], ["/refunds", "GET"], ["/night-audit", "GET"],
    [access, "GET"], [access, "POST", { email: owner.email, role: "administrator" }], ["/rooms", "POST", {}],
    ["/rates", "POST", {}], ["/housekeeping/rooms/room-one/complete", "POST", {}], ["/invoices", "POST", {}],
    ["/invoices/invoice-one/payments", "POST", { status: "refunded", amount: 100 }],
    ["/bookings/reservations/booking-one/payments", "POST", { status: "refunded", amount: 100 }],
    ["/bookings/reservations/booking-one", "DELETE"]
  ]) assert.equal((await request(staff, path, method, body)).status, 403, `${method} ${path}`);

  const roomType = new RoomType({ property_id: property.property_id, name: "Standard", physical_rooms: [
    { room_number: "T102" }, { room_number: "T103" }
  ] });
  const [source, destination] = roomType.physical_rooms;
  const reservation = new Reservation({ property_id: property.property_id, reservation_no: "RES-REASSIGN", status: "confirmed",
    check_in: "2026-11-22", check_out: "2026-11-24", booker: { name: "Test Guest" },
    rooms: [{ room_type_id: roomType._id, room_type_name: roomType.name, physical_room_id: source._id, room_number: source.room_number }]
  });
  RoomType.find.mock.mockImplementation(() => query([roomType]));
  t.mock.method(Reservation, "findOne", (filter) => {
    assert.equal(filter.property_id, property.property_id);
    return query(String(reservation._id) === filter._id ? reservation : null);
  });
  t.mock.method(reservation, "save", async () => reservation);
  t.mock.method(Invoice, "findOne", () => query(null));
  t.mock.method(require("../db_models/business-block.model"), "find", () => query([]));
  const reassignmentPath = `/bookings/reservations/${reservation._id}/room-reassignment`;
  const reassignment = { room_line_id: String(reservation.rooms[0]._id),
    from_physical_room_id: String(source._id), to_physical_room_id: String(destination._id), expected_version: 0 };
  const moved = await request(staff, reassignmentPath, "POST", reassignment);
  assert.equal(moved.status, 200, moved.status === 200 ? undefined : await moved.text());
  const payload = await moved.json();
  assert.equal(payload.reservation.reservation_no, "RES-REASSIGN");
  assert.equal(payload.reservation.rooms[0].room_number, "T103");

  const other = new Reservation({ property_id: property.property_id, reservation_no: "RES-SWAP-OTHER", status: "confirmed",
    check_in: "2026-11-22", check_out: "2026-11-24", booker: { name: "Other Guest" },
    rooms: [{ room_type_id: roomType._id, physical_room_id: source._id, room_number: source.room_number }] });
  Reservation.findOne.mock.mockImplementation(filter => {
    assert.equal(filter.property_id, property.property_id);
    assert.equal(filter.deleted_at.$exists, false);
    return query([reservation, other].find(item => String(item._id) === filter._id));
  });
  t.mock.method(other, "save", async () => other);
  const swapPath = `/bookings/reservations/${reservation._id}/room-swap`;
  const swap = { room_line_id: String(reservation.rooms[0]._id), from_physical_room_id: String(destination._id), expected_version: 0,
    other: { reservation_id: String(other._id), room_line_id: String(other.rooms[0]._id), from_physical_room_id: String(source._id), expected_version: 0 } };
  assert.equal((await request(staff, swapPath, "POST", { ...swap, other: { ...swap.other, reservation_id: String(new mongoose.Types.ObjectId()) } })).status, 404);
  const swapped = await request(staff, swapPath, "POST", swap);
  assert.equal(swapped.status, 200, await swapped.clone().text());
  assert.deepEqual((await swapped.json()).reservations.map(item => item.rooms[0].room_number), ["T102", "T103"]);

  assert.equal((await request(admin, `${access}/${staff._id}`, "PATCH", { role: "member" })).status, 200);
  assert.equal(property.staff_roles.length, 0);
  assert.equal((await request(admin, `${access}/${staff._id}`, "PATCH", { role: "front_desk" })).status, 200);
  assert.equal((await request(owner, `${access}/${staff._id}`, "PATCH", { role: "administrator" })).status, 200);
  assert.equal(property.staff_roles.length, 0);
  assert.equal(propertyRole(property, staff), "administrator");
  assert.equal((await request(owner, `${access}/${staff._id}`, "PATCH", { role: "front_desk" })).status, 200);
  assert.equal(property.administrator_ids.some((id) => String(id) === String(staff._id)), false);
  assert.equal((await request(owner, `${access}/${staff._id}`, "DELETE")).status, 200);
  assert.equal(property.staff_roles.length, 0);
  assert.equal((await request(staff, "/rooms")).status, 403);
  assert.equal((await request(staff, reassignmentPath, "POST", reassignment)).status, 403);
  const invalid = new Property({ ...property, staff_roles: [{ user_id: staff._id, role: "front_desk" }] });
  await assert.rejects(invalid.validate(), /Staff roles require/);
});
