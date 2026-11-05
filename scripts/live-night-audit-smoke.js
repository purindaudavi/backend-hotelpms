// Disposable integration fixtures only; never alters existing hotels or users.
require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict"), crypto = require("node:crypto"), mongoose = require("mongoose"), jwt = require("jsonwebtoken");
const User = require("../db_models/user.model"), Property = require("../db_models/property.model"), NightAudit = require("../db_models/night-audit.model"), Report = require("../db_models/reports.model"), Audit = require("../db_models/booking-log.model"), Guard = require("../db_models/inventory-guard.model"), Transaction = require("../db_models/financial-transaction.model"), Reservation = require("../db_models/booking.model"), Room = require("../db_models/rooms.model");
const propertyId = `night-smoke-${crypto.randomBytes(5).toString("hex")}`, ids = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
let server, checks = 0;
async function main() {
  await mongoose.connect(process.env.mongoURI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const [owner, admin, desk, finance, outsider] = await User.create(ids.map((_id, index) => ({ _id, name: `Night Audit Test ${index}`, email: `${propertyId}-${index}@example.test`, password: "disposable-no-login", mobile: "0771234567" })));
  await Property.create({ property_id: propertyId, owner_id: owner._id, member_ids: [admin._id, desk._id, finance._id], administrator_ids: [admin._id], staff_roles: [{ user_id: desk._id, role: "front_desk" }, { user_id: finance._id, role: "finance" }], business_date: new Date("2026-10-30"), info: { hotel_name: propertyId, address: "Disposable fixture", email: "h@example.test", country_code: "LK" } });
  const { app } = require("../app"); server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const call = async (actor, path, method = "GET", body = {}) => fetch(`http://127.0.0.1:${server.address().port}/api${path}${method === "GET" ? `?property_id=${propertyId}` : ""}`, { method, headers: { Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET, { expiresIn: "10m" })}`, "Content-Type": "application/json", "x-user-id": String(owner._id) }, ...(method !== "GET" ? { body: JSON.stringify({ property_id: propertyId, ...body }) } : {}) });
  const expect = async (response, status) => { assert.equal(response.status, status, await response.clone().text()); checks++; return response.json(); };
  const write = (actor, action, audit, body = {}) => call(actor, `/night-audit/current/${action}`, action === "notes" ? "PATCH" : "POST", { audit_id: audit._id, ...body });
  const prepare = async (actor, audit) => {
    const priorReportCount = await Report.countDocuments({ property_id: propertyId });
    for (const step_id of ["front-desk-status", "payment-reconciliation"]) await expect(await write(actor, "review", audit, { step_id }), 200);
    await expect(await write(actor, "post-room-revenue", audit), 200);
    await expect(await write(actor, "review-housekeeping", audit), 200);
    const packs = await Promise.all([1, 2].map(() => write(actor, "generate-reports", audit)));
    for (const pack of packs) { const result = await expect(pack, 200); assert.equal(result.night_audit.reports.length, 6); }
    assert.equal(await Report.countDocuments({ property_id: propertyId }), priorReportCount + 6); checks++;
  };
  await expect(await call(desk, "/night-audit/current"), 403);
  await expect(await call(finance, `/properties/${propertyId}/access/${desk._id}/night-audit`, "PATCH", { enabled: true }), 403);
  await expect(await call(admin, `/properties/${propertyId}/access/${desk._id}/night-audit`, "PATCH", { enabled: true }), 200);
  const access = await expect(await call(desk, `/properties/${propertyId}/my-access`), 200); assert.ok(access.permissions.includes("night-audit.run")); checks++;
  const audit = (await expect(await call(desk, "/night-audit/current"), 200)).night_audit;
  await expect(await call(outsider, `/night-audit/${audit._id}`), 403);
  await expect(await call(finance, `/night-audit/${audit._id}/finance-review`, "POST", { status: "reviewed", version: audit.version }), 409);
  await expect(await write(desk, "override", audit, { step_id: "front-desk-status", reason: "Not allowed override" }), 403);
  await expect(await write(desk, "complete", audit), 409);
  await expect(await call(desk, "/night-audit/current/review", "POST", { step_id: "front-desk-status" }), 400);
  await prepare(desk, audit);
  await expect(await write(desk, "notes", audit, { close_note: "Night shift handover" }), 200);
  const closes = await Promise.all([1, 2].map(() => write(desk, "complete", audit)));
  assert.deepEqual(closes.map(result => result.status).sort(), [200, 409]); checks++;
  const closed = (await expect(await call(finance, `/night-audit/${audit._id}`), 200)).night_audit;
  assert.equal(closed.closed_by.user_id, String(desk._id)); assert.equal(closed.finance_review_status, "pending_review"); checks++;
  const next = (await expect(await call(owner, "/night-audit/current"), 200)).night_audit; assert.equal(next.business_date, "2026-10-31"); checks++;
  const immutable = JSON.stringify({ summary: closed.close_summary, closed_by: closed.closed_by, closed_at: closed.closed_at });
  await expect(await call(finance, "/night-audit/current/complete", "POST", { audit_id: next._id }), 403);
  await expect(await call(owner, `/night-audit/${audit._id}/finance-review`, "POST", { status: "reviewed", version: closed.version }), 403);
  const flagged = (await expect(await call(finance, `/night-audit/${audit._id}/finance-review`, "POST", { status: "flagged", note: "Check missing receipt", version: closed.version }), 200)).night_audit;
  await expect(await call(finance, `/night-audit/${audit._id}/finance-review`, "POST", { status: "reviewed", version: closed.version }), 409);
  const reviewed = (await expect(await call(finance, `/night-audit/${audit._id}/finance-review`, "POST", { status: "reviewed", note: "Receipt verified", version: flagged.version }), 200)).night_audit;
  assert.equal(reviewed.finance_review_history.length, 2); assert.equal(reviewed.finance_reviewed_by.user_id, String(finance._id)); assert.equal(JSON.stringify({ summary: reviewed.close_summary, closed_by: reviewed.closed_by, closed_at: reviewed.closed_at }), immutable); assert.equal((await Property.findOne({ property_id: propertyId })).business_date.toISOString().slice(0, 10), "2026-10-31"); checks++;
  await expect(await call(owner, `/properties/${propertyId}/access/${desk._id}/night-audit`, "PATCH", { enabled: false }), 200);
  await expect(await write(desk, "notes", next, { close_note: "Revoked" }), 403);
  await expect(await call(desk, "/night-audit/current"), 403);
  const type = await Room.create({ property_id: propertyId, name: "Standard", maximum_adults: 2, base_rate: 5000, currency: "LKR", physical_rooms: [{ room_number: "N101", active: true, operational_status: "occupied", housekeeping_status: "clean" }] });
  await Reservation.create({ property_id: propertyId, reservation_no: `${propertyId}-RES`, check_in: "2026-10-31", check_out: "2026-11-01", status: "checked_in", currency: "LKR", booking_source: "Direct", booker: { name: "Test Guest", phone: "0771234567", email: "g@example.test", country: "Sri Lanka" }, rooms: [{ room_type_id: type._id, room_type_name: type.name, physical_room_id: type.physical_rooms[0]._id, room_number: "N101", adults: 2, children: 0, original_nightly_rate: 5000, effective_nightly_rate: 5000 }] });
  await prepare(admin, next);
  await expect(await write(owner, "post-room-revenue", next), 200);
  assert.equal(await Transaction.countDocuments({ property_id: propertyId, source_type: "night_audit" }), 1); checks++;
  await expect(await write(owner, "complete", next), 200);
  const finished = await NightAudit.findById(next._id); assert.equal(finished.closed_by.user_id, String(owner._id)); assert.equal(finished.finance_review_status, "pending_review"); assert.equal(finished.revenue_posted_amount, 5000); checks++;
  const third = (await expect(await call(admin, "/night-audit/current"), 200)).night_audit;
  await expect(await write(admin, "complete", third), 409);
  await expect(await write(admin, "override", third, { step_id: "front-desk-status", reason: "short" }), 400);
  await expect(await write(admin, "override", third, { step_id: "front-desk-status", reason: "Guest departure reviewed; follow-up assigned for this disposable test." }), 200);
  await prepare(admin, third);
  await expect(await write(admin, "complete", third), 200);
  assert.equal((await NightAudit.findById(third._id)).closed_by.user_id, String(admin._id)); checks++;
  await expect(await call(owner, `/properties/${propertyId}/access/${finance._id}/night-audit`, "PATCH", { enabled: true }), 400);
  await expect(await call(owner, `/properties/${propertyId}/access/${desk._id}/night-audit`, "PATCH", { enabled: true }), 200);
  await expect(await call(owner, `/properties/${propertyId}/access/${desk._id}`, "PATCH", { role: "finance" }), 200);
  await expect(await call(owner, `/properties/${propertyId}/access/${desk._id}`, "PATCH", { role: "front_desk" }), 200);
  await expect(await call(desk, "/night-audit/current"), 403);
  await expect(await call(finance, `/night-audit/${new mongoose.Types.ObjectId()}/finance-review`, "POST", { status: "reviewed", version: 0 }), 404);
  console.log(`PASS: ${checks} Night Audit integration checks, including Owner/Admin and delegated Front Desk execution, concurrent close/report requests, positive revenue posted once, independent Finance review/history, stale requests and revocation.`);
}
main().catch(error => { console.error(`FAIL: ${error.name} after ${checks} checks.`); if (error.name === "AssertionError") console.error(error.message.slice(0, 1400), error.stack.split("\n").find(line => line.includes("live-night-audit-smoke"))); process.exitCode = 1; }).finally(async () => {
  try { if (server) await new Promise(resolve => server.close(resolve)); if (mongoose.connection.readyState === 1) { for (const model of [Report, Audit, Transaction, Reservation, Room, NightAudit, Property]) await model.deleteMany({ property_id: propertyId }); await Guard.deleteMany({ _id: propertyId }); await User.deleteMany({ _id: { $in: ids } }); assert.equal(await NightAudit.countDocuments({ property_id: propertyId }), 0); assert.equal(await User.countDocuments({ _id: { $in: ids } }), 0); console.log("Disposable Night Audit fixtures removed; cleanup verified."); } }
  catch { console.error(`Cleanup needs inspection for ${propertyId}.`); process.exitCode = 1; } finally { await mongoose.disconnect(); }
});
