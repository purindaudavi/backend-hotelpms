const test = require("node:test"), assert = require("node:assert/strict"), mongoose = require("mongoose"), jwt = require("jsonwebtoken");
const Property = require("../db_models/property.model"), User = require("../db_models/user.model"), Reservation = require("../db_models/booking.model");
const Payment = require("../db_models/reservation-payment.model"), Attachment = require("../db_models/reservation-attachment.model"), Audit = require("../db_models/booking-log.model"), Report = require("../db_models/reports.model");
const FinancialTransaction = require("../db_models/financial-transaction.model"), Withdrawal = require("../db_models/withdrawal.model");
const { authorizePropertyRequest, permissionsForRole, FINANCE_REPORT_TYPES } = require("../services/property-permissions.service");
const { billingReservation } = require("../services/finance-role.service");
const { notificationTypesForRole } = require("../services/notification.service");

test("Finance uses an explicit API allowlist and cannot approve, void, change operations or request non-financial reports", () => {
  const allowed = [["GET", "/finance/overview"], ["GET", "/bookings/reservations"], ["GET", "/bookings/reservations/ref"], ["GET", "/invoices"], ["POST", "/invoices"], ["POST", "/invoices/id/issue"], ["POST", "/invoices/id/payments"], ["POST", "/credits"], ["PATCH", "/credits/id"], ["POST", "/refunds"], ["POST", "/withdrawals"], ["POST", "/purchases/id/pay"], ["GET", "/financial-targets"], ["GET", "/night-audit/current"], ["GET", "/reports/history"], ["POST", "/reports/generate", { report_type: "collection-report" }]];
  const denied = [["POST", "/bookings/reservations"], ["PATCH", "/bookings/reservations/id"], ["POST", "/bookings/reservations/id/check-out"], ["GET", "/bookings/reservations/id/attachments"], ["GET", "/rooms"], ["POST", "/rates/quote"], ["GET", "/guests"], ["GET", "/housekeeping"], ["GET", "/integrations"], ["PATCH", "/properties/hotel/info"], ["POST", "/properties/hotel/access"], ["POST", "/credits/id/issue"], ["POST", "/refunds/id/complete"], ["POST", "/refunds/id/void"], ["POST", "/withdrawals/id/complete"], ["POST", "/withdrawals/id/void"], ["POST", "/invoices/id/void"], ["POST", "/invoices/id/payments/pay/void"], ["POST", "/expenses/id/void"], ["PUT", "/financial-targets/2026-10"], ["POST", "/night-audit/current/complete"], ["POST", "/night-audit/current/post-room-revenue"], ["POST", "/reports/generate", { report_type: "information-sheet", role: "owner" }], ["POST", "/invoices/id/payments", { status: "voided" }]];
  for (const [method, path, body] of [...allowed, ...denied]) {
    let passed = false, status;
    authorizePropertyRequest({ propertyRole: "finance", method, path, body }, { status(value) { status = value; return this; }, json() {} }, () => { passed = true; });
    assert.equal(passed, allowed.some(item => item[0] === method && item[1] === path && item[2] === body), `${method} ${path}`);
    if (!passed) assert.equal(status, 403);
  }
  assert.ok(!permissionsForRole("finance").includes("operations.manage"));
  assert.equal(notificationTypesForRole("finance").length, 9);
  assert.ok(!notificationTypesForRole("finance").includes("booking"));
});

test("Finance billing projection and model role cannot expose operational notes, occupant documents or attendant links", async () => {
  const userId = new mongoose.Types.ObjectId();
  const property = new Property({ property_id: "finance-model", member_ids: [userId], staff_roles: [{ user_id: userId, role: "finance" }], info: { hotel_name: "Finance hotel", address: "Road", email: "h@example.test", country_code: "LK" } });
  await property.validate();
  property.staff_roles[0].attendant_id = new mongoose.Types.ObjectId();
  await assert.rejects(property.validate(), /Only Housekeeping/);
  const projected = billingReservation({ _id: "booking", property_id: "finance-model", reservation_no: "RES-1", internal_remarks: "private operations", attachments: ["passport"], occupants: [{ passport_number: "secret" }], booker: { name: "Guest", email: "g@example.test", title: "Private title" }, rooms: [{ room_number: "101", effective_nightly_rate: 5000, internal_notes: "private" }] });
  assert.equal(projected.booker.name, "Guest"); assert.equal(projected.rooms[0].room_number, "101");
  assert.ok(!JSON.stringify(projected).includes("private")); assert.ok(!JSON.stringify(projected).includes("passport")); assert.equal(projected.booker.title, undefined);
});

function query(value) { return { session() { return this; }, select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }
function matches(record, filter) { return Object.entries(filter).every(([key, value]) => { if (key === "$or") return value.some(item => matches(record, item)); const actual = record[key]; if (value && typeof value === "object" && !(value instanceof mongoose.Types.ObjectId)) { if (value.$exists !== undefined) return (actual !== undefined) === value.$exists; if (value.$in) return value.$in.some(item => String(item) === String(actual)); } return String(actual) === String(value); }); }
test("JWT Finance access grants/revokes per property; billing and report history are scoped and administrative routes stay blocked", async t => {
  process.env.JWT_SECRET = "finance-role-isolated-secret";
  const make = name => ({ _id: new mongoose.Types.ObjectId(), name, email: `${name}@example.test`, role: "user" });
  const owner = make("owner"), admin = make("admin"), finance = make("finance"), outsider = make("outsider"), users = [owner, admin, finance, outsider];
  const propertyId = "finance-http", property = new Property({ property_id: propertyId, owner_id: owner._id, member_ids: [admin._id], administrator_ids: [admin._id], info: { hotel_name: "Finance hotel", address: "Private address", email: "hotel@example.test", country_code: "LK", cm_property_id: "private-channel" } });
  const reservation = { _id: new mongoose.Types.ObjectId(), property_id: propertyId, reservation_no: "RES-FINANCE", internal_remarks: "private-remark", booker: { name: "Billing Guest" }, rooms: [] };
  const reports = [{ _id: new mongoose.Types.ObjectId(), property_id: propertyId, report_type: "collection-report" }, { _id: new mongoose.Types.ObjectId(), property_id: propertyId, report_type: "information-sheet" }];
  t.mock.method(require("../db_models/inventory-guard.model"), "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(mongoose, "startSession", async () => ({ async withTransaction(work) { return work(); }, async endSession() {} }));
  t.mock.method(User, "findById", id => query(users.find(user => String(user._id) === String(id)) || null));
  t.mock.method(User, "findOne", filter => query(users.find(user => user.email === filter.email) || null));
  t.mock.method(Property, "findOne", filter => query(matches(property, filter) ? property : null));
  t.mock.method(Property.prototype, "save", async function () { await this.validate(); return this; });
  t.mock.method(Audit, "create", async values => values);
  t.mock.method(Reservation, "find", filter => query(matches(reservation, filter) ? [reservation] : []));
  t.mock.method(Reservation, "countDocuments", filter => query(matches(reservation, filter) ? 1 : 0));
  t.mock.method(Reservation, "findOne", filter => query(matches(reservation, filter) ? reservation : null));
  t.mock.method(Payment, "find", () => query([]));
  t.mock.method(Attachment, "find", () => assert.fail("Finance must not load reservation attachments"));
  t.mock.method(Report, "find", filter => query(reports.filter(record => matches(record, filter))));
  t.mock.method(Report, "countDocuments", filter => query(reports.filter(record => matches(record, filter)).length));
  t.mock.method(Report, "findOne", filter => query(reports.find(record => matches(record, filter)) || null));
  const transactions = [owner, finance].map(actor => ({ property_id: propertyId, created_by: { user_id: String(actor._id), name: "Shared name" } }));
  const withdrawals = [
    { recipient_user_id: owner._id, recorded_by: { user_id: String(admin._id) }, amount: 1000 },
    { recipient_user_id: admin._id, recorded_by: { user_id: String(owner._id) }, amount: 3000 }
  ].map(row => ({ ...row, property_id: propertyId, status: "completed", currency: "LKR" }));
  const transactionsFor = filter => {
    const { "created_by.user_id": actorId, ...fields } = filter;
    return transactions.filter(row => matches(row, fields) && (!actorId || row.created_by.user_id === actorId));
  };
  const asDocuments = rows => rows.map(row => ({ toObject: () => ({ ...row }) }));
  t.mock.method(FinancialTransaction, "find", filter => query(asDocuments(transactionsFor(filter))));
  t.mock.method(FinancialTransaction, "countDocuments", async filter => transactionsFor(filter).length);
  t.mock.method(Withdrawal, "find", filter => query(asDocuments(withdrawals.filter(row => matches(row, filter)))));
  t.mock.method(Withdrawal, "countDocuments", async filter => withdrawals.filter(row => matches(row, filter)).length);
  t.mock.method(Withdrawal, "aggregate", async ([{ $match: filter }]) => {
    assert.ok(filter.recipient_user_id instanceof mongoose.Types.ObjectId);
    const rows = withdrawals.filter(row => matches(row, filter));
    return [{ _id: "LKR", count: rows.length, amount: rows.reduce((sum, row) => sum + row.amount, 0) }];
  });
  const { app } = require("../app"), server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (actor, path, method = "GET", body) => fetch(`http://127.0.0.1:${server.address().port}/api${path}${method === "GET" ? `${path.includes("?") ? "&" : "?"}property_id=${propertyId}` : ""}`, { method, headers: { Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET)}`, "Content-Type": "application/json", "x-user-id": String(owner._id) }, ...(body ? { body: JSON.stringify({ property_id: propertyId, ...body }) } : {}) });
  assert.equal((await call(finance, "/reports/catalog")).status, 403);
  const granted = await call(admin, `/properties/${propertyId}/access`, "POST", { email: finance.email, role: "finance" }); assert.equal(granted.status, 201, await granted.clone().text());
  const access = await (await call(finance, `/properties/${propertyId}/my-access`)).json(); assert.equal(access.role, "finance");
  const personalActivity = await call(finance, "/transactions?mine=true");
  assert.equal(personalActivity.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await personalActivity.json()).transactions.map(row => row.created_by.user_id), [String(finance._id)]);
  assert.equal((await (await call(finance, "/transactions")).json()).total, 2);
  const personalWithdrawals = await call(owner, "/withdrawals?mine=true&status=completed");
  assert.equal(personalWithdrawals.headers.get("cache-control"), "private, no-store");
  const withdrawalSummary = await personalWithdrawals.json();
  assert.deepEqual(withdrawalSummary.totals, [{ currency: "LKR", amount: 1000, count: 1 }]);
  assert.deepEqual(withdrawalSummary.withdrawals.map(row => row.recipient_user_id), [String(owner._id)]);
  const metadata = await (await call(finance, `/properties/${propertyId}`)).json(); assert.ok(!JSON.stringify(metadata).includes("private-channel"));
  const billing = await (await call(finance, "/bookings/reservations?details=true")).json(); assert.equal(billing.reservations[0].booker.name, "Billing Guest"); assert.ok(!JSON.stringify(billing).includes("private-remark"));
  const detail = await call(finance, `/bookings/reservations/${reservation._id}`); assert.equal(detail.status, 200, await detail.clone().text()); assert.deepEqual((await detail.json()).attachments, []);
  const catalog = await (await call(finance, "/reports/catalog")).json(); assert.deepEqual(catalog.reports.map(item => item.report_type).sort(), [...FINANCE_REPORT_TYPES].sort());
  const history = await (await call(finance, "/reports/history")).json(); assert.equal(history.total, 1);
  assert.equal((await call(finance, `/reports/history/${reports[1]._id}`)).status, 404);
  for (const path of ["/housekeeping", "/rooms", "/guests", "/integrations", `/properties/${propertyId}/access`]) assert.equal((await call(finance, path)).status, 403, path);
  for (const path of ["/refunds/record/complete", "/withdrawals/record/complete", "/credits/record/issue", "/night-audit/current/complete"]) assert.equal((await call(finance, path, "POST", { role: "owner", approved_by: owner })).status, 403, path);
  assert.equal((await call(finance, "/reports/generate", "POST", { report_type: "information-sheet" })).status, 403);
  assert.equal((await call(outsider, "/reports/catalog")).status, 403);
  assert.equal((await call(admin, `/properties/${propertyId}/access/${finance._id}`, "DELETE", {})).status, 200);
  assert.equal((await call(finance, "/reports/catalog")).status, 403);
});
