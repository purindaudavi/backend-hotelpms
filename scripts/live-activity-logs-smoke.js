// Actual authenticated API + MongoDB. All writes use disposable, prefixed fixtures.
require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict"), crypto = require("node:crypto"), mongoose = require("mongoose"), jwt = require("jsonwebtoken");
const User = require("../db_models/user.model"), Property = require("../db_models/property.model"), Audit = require("../db_models/booking-log.model");
const { HousekeepingAttendant: Attendant } = require("../db_models/housecleaning.model");
const { writeAuditLog } = require("../services/booking-audit.service");
const prefix = `activity-smoke-${crypto.randomBytes(5).toString("hex")}`, otherId = `${prefix}-other`;
const ids = Array.from({ length: 7 }, () => new mongoose.Types.ObjectId());
let server, checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

async function main() {
  await mongoose.connect(process.env.mongoURI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const [owner, admin, finance, desk, keeper, member, outsider] = await User.create(ids.map((_id, i) => ({ _id, name: `Activity Test ${i}`, email: `${prefix}-${i}@example.test`, password: "disposable-no-login", mobile: "0771234567" })));
  const info = { hotel_name: prefix, address: "Disposable fixture", email: "hotel@example.test", country_code: "LK", timezone: "Asia/Colombo" };
  const attendant = await Attendant.create({ property_id: prefix, name: "Test Attendant", employee_number: "HK-TEST", status: "active" });
  await Property.create([{ property_id: prefix, owner_id: owner._id, member_ids: [admin._id, finance._id, desk._id, keeper._id, member._id], administrator_ids: [admin._id], staff_roles: [{ user_id: finance._id, role: "finance" }, { user_id: desk._id, role: "front_desk" }, { user_id: keeper._id, role: "housekeeping", attendant_id: attendant._id }], info }, { property_id: otherId, owner_id: outsider._id, info }]);
  const actor = user => ({ user_id: String(user._id), name: user.name, email: user.email });
  const rows = [
    ["2026-11-11T18:29:59Z", "reservation", "reservation_created", "RES-BEFORE hotel date", owner],
    ["2026-11-11T18:30:00Z", "reservation", "reservation_updated", "RES-START hotel date", desk],
    ["2026-11-12T12:00:00Z", "housekeeping_task", "cleaning_completed", "Room T101 completed", keeper],
    ["2026-11-12T12:00:00Z", "money_request", "approved", "MR-TEST approved", owner],
    ["2026-11-12T18:29:59Z", "property", "property_info_updated", "=FORMULA()", admin],
    ["2026-11-12T18:30:00Z", "invoice", "invoice_issued", "INV-NEXT hotel date", finance]
  ];
  for (const [created_at, entityType, action, description, user] of rows) {
    const record = await writeAuditLog({ propertyId: prefix, entityType, entityId: new mongoose.Types.ObjectId(), action, description, actor: actor(user), changes: [{ field: "status", from: "confirmed", to: "checked_in" }] });
    // Explicit test-only fixture clock; immutable production timestamps have no API edits.
    await Audit.collection.updateOne({ _id: record._id }, { $set: { created_at: new Date(created_at) } });
  }
  await writeAuditLog({ propertyId: otherId, entityType: "property", entityId: new mongoose.Types.ObjectId(), action: "property_created", description: "OTHER PROPERTY SECRET", actor: actor(outsider) });
  const { app } = require("../app"); server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const call = (user, path = "/activity-logs", propertyId = prefix, method = "GET", extraHeaders = {}) => fetch(`${origin}${path}${path.includes("?") ? "&" : "?"}property_id=${propertyId}`, { method, headers: { ...(user ? { Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: "10m" })}` } : {}), ...extraHeaders } });
  const body = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); checks++; return response.json(); };
  const first = await body(await call(owner)); ok(first.total === 6 && first.logs.length === 6, "All real property records loaded");
  ok(first.logs.every(log => log.description !== "OTHER PROPERTY SECRET"), "Other property excluded");
  const localDay = await body(await call(admin, "/activity-logs?date_from=2026-11-12&date_to=2026-11-12"));
  ok(localDay.total === 4 && localDay.timezone === "Asia/Colombo", "Inclusive hotel local date boundaries");
  ok(localDay.logs.some(log => log.description === "RES-START hotel date") && !localDay.logs.some(log => log.description === "INV-NEXT hotel date"), "Exact midnight boundaries");
  const housekeeping = await body(await call(owner, "/activity-logs?entity_type=housekeeping_task")); ok(housekeeping.total === 1 && housekeeping.logs[0].actor.name === keeper.name, "Historical verified actor shown");
  ok(housekeeping.logs[0].changes[0].to === "checked_in", "Field comparisons retained");
  const user = await body(await call(owner, `/activity-logs?user=${encodeURIComponent(desk.email)}`)); ok(user.total === 1, "User email filter");
  const literal = await body(await call(owner, "/activity-logs?search=.*")); ok(literal.total === 0, "Search interpreted literally");
  const page1 = await body(await call(owner, "/activity-logs?limit=2&page=1")), page2 = await body(await call(owner, "/activity-logs?limit=2&page=2"));
  ok(page1.pages === 3 && new Set([...page1.logs, ...page2.logs].map(l => l.id)).size === 4, "Stable pagination with tied timestamps");
  const action = await body(await call(owner, "/activity-logs?action=approved")); ok(action.total === 1, "Exact action filter");
  for (const staff of [finance, desk, keeper, member]) { await body(await call(staff), 403); await body(await call(staff, "/activity-logs/export"), 403); }
  await body(await call(outsider), 403); await body(await call(owner, "/activity-logs", otherId), 403);
  await body(await call(null), 401);
  await body(await call(owner, "/activity-logs", prefix, "GET", { "x-property-id": otherId }), 400);
  for (const method of ["POST", "PATCH", "DELETE"]) await body(await call(owner, "/activity-logs", prefix, method), 403);
  const csv = await call(admin, "/activity-logs/export?entity_type=property"); ok(csv.status === 200 && csv.headers.get("content-type").includes("text/csv"), "CSV download supported");
  const csvText = await csv.text(); ok(csvText.includes("'=FORMULA()") && !csvText.includes("OTHER PROPERTY SECRET") && csvText.includes(admin.email), "CSV matches scoped filters and escapes formulas");
  for (const query of ["date_from=2026-02-30", "date_from=2026-11-13&date_to=2026-11-12", "entity_type=users", "limit=999999"]) await body(await call(owner, `/activity-logs?${query}`), 400);
  await Property.updateOne({ property_id: prefix }, { $pull: { member_ids: admin._id, administrator_ids: admin._id } });
  await body(await call(admin), 403); // Existing JWT must not preserve revoked access.
  ok(await Audit.countDocuments({ property_id: prefix }) === 6, "Reads and exports do not mutate history");
  console.log(`PASS: ${checks} real MongoDB/authenticated API checks for Activity Logs; property isolation, roles, revocation, local dates, stable pagination, comparisons, filtered export and read-only behavior.`);
}

main().catch(error => { console.error(`FAIL after ${checks} checks: ${error.message.slice(0, 1500)}`); process.exitCode = 1; }).finally(async () => {
  try {
    if (server) await new Promise(r => server.close(r));
    if (mongoose.connection.readyState === 1) {
      assert.ok(prefix.startsWith("activity-smoke-"));
      for (const Model of [Audit, Property, Attendant]) { await Model.deleteMany({ property_id: { $in: [prefix, otherId] } }); assert.equal(await Model.countDocuments({ property_id: { $in: [prefix, otherId] } }), 0); }
      await User.deleteMany({ _id: { $in: ids }, email: { $regex: `^${prefix}-` } }); assert.equal(await User.countDocuments({ _id: { $in: ids } }), 0);
      console.log("Disposable Activity Logs fixtures removed; cleanup verified.");
    }
  } catch (error) { console.error(`Cleanup needs inspection for ${prefix}: ${error.message}`); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
});
