require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict"), crypto = require("node:crypto"), mongoose = require("mongoose"), jwt = require("jsonwebtoken");
const User = require("../db_models/user.model"), Property = require("../db_models/property.model"), Night = require("../db_models/night-audit.model"), Report = require("../db_models/reports.model"), Audit = require("../db_models/booking-log.model"), Guard = require("../db_models/inventory-guard.model");
const Invoice = require("../db_models/invoice.model"), Payment = require("../db_models/reservation-payment.model"), Transaction = require("../db_models/financial-transaction.model"), Reservation = require("../db_models/booking.model"), Room = require("../db_models/rooms.model"), Counter = require("../db_models/document-counter.model");
const propertyId = `night-v2-${crypto.randomBytes(5).toString("hex")}`, ids = Array.from({ length: 6 }, () => new mongoose.Types.ObjectId());
let server, checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
async function main() {
  await mongoose.connect(process.env.mongoURI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const [owner, admin, desk, finance, member, outsider] = await User.create(ids.map((_id, i) => ({ _id, name: `Audit V2 ${i}`, email: `${propertyId}-${i}@example.test`, password: "disposable-no-login", mobile: "0771234567" })));
  await Property.create({ property_id: propertyId, owner_id: owner._id, member_ids: [admin._id, desk._id, finance._id, member._id], administrator_ids: [admin._id], staff_roles: [{ user_id: desk._id, role: "front_desk", run_night_audit: true }, { user_id: finance._id, role: "finance" }], business_date: "2026-11-10", info: { hotel_name: propertyId, address: "Disposable fixture", email: "h@example.test", country_code: "LK", timezone: "Asia/Colombo" } });
  const type = await Room.create({ property_id: propertyId, name: "Standard", maximum_adults: 2, base_rate: 6500, currency: "LKR", physical_rooms: [{ room_number: "N101", active: true, operational_status: "occupied", housekeeping_status: "clean" }, { room_number: "N102", active: true, operational_status: "available", housekeeping_status: "dirty" }] });
  const booking = (no, status, day = false) => ({ property_id: propertyId, reservation_no: no, check_in: "2026-11-10", check_out: day ? "2026-11-10" : "2026-11-12", is_day_room: day, status, currency: "LKR", booking_source: "Direct", booker: { name: no, phone: "0771234567", email: "g@example.test", country: "Sri Lanka" }, rooms: [{ room_type_id: type._id, room_type_name: type.name, physical_room_id: type.physical_rooms[0]._id, room_number: "N101", adults: 2, children: 0, original_nightly_rate: 6500, effective_nightly_rate: 6500 }] });
  const stay = await Reservation.create(booking("RES-V2-STAY", "checked_in"));
  const dayStay = await Reservation.create(booking("RES-V2-DAY", "checked_out", true));
  const missing = await Reservation.create(booking("RES-V2-MISSING", "confirmed"));
  const invoiceFor = (r, no, quantity) => Invoice.create({ property_id: propertyId, invoice_no: no, reservation_id: r._id, reservation_no: r.reservation_no, guest_id: new mongoose.Types.ObjectId(), currency: "LKR", status: "issued", billing_snapshot: { name: r.booker.name }, stay_snapshot: { check_in: r.check_in, check_out: r.check_out, nights: r.is_day_room ? 0 : 2, is_day_room: r.is_day_room, room_numbers: ["N101"] }, line_items: [{ source_type: "accommodation", service_date: "2026-11-10", description: "Hotel accommodation", quantity, unit_price: 6500, tax_rate: 10 }] });
  const invoice = await invoiceFor(stay, "INV-V2-STAY", 2), dayInvoice = await invoiceFor(dayStay, "INV-V2-DAY", 1);
  const pay = (amount, currency, payment_method, posted_at, reference = "REF-OK") => Payment.create({ property_id: propertyId, reservation_id: stay._id, invoice_id: invoice._id, invoice_no: invoice.invoice_no, amount, currency, payment_method, payment_reference: reference, posted_at });
  await pay(5000, "LKR", "cash", "2026-11-09T18:30:00Z"); // hotel local Nov 10
  await pay(20, "USD", "bank_transfer", "2026-11-10T10:00:00Z");
  await pay(777, "LKR", "cash", "2026-11-10T18:30:00Z"); // hotel local Nov 11
  const { app } = require("../app"); server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  const call = (actor, path, method = "GET", body = {}) => fetch(`http://127.0.0.1:${server.address().port}/api${path}${method === "GET" ? `?property_id=${propertyId}` : ""}`, { method, headers: { Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET, { expiresIn: "10m" })}`, "Content-Type": "application/json", "x-user-id": String(outsider._id), "x-user-name": "Forged actor" }, ...(method === "GET" ? {} : { body: JSON.stringify({ property_id: propertyId, ...body }) }) });
  const expect = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); checks++; return r.json(); };
  const get = async () => (await expect(await call(desk, "/night-audit/current"))).night_audit;
  const write = (user, action, a, body) => call(user, `/night-audit/current/${action}`, "POST", { audit_id: a._id, ...body });
  for (const u of [member, outsider]) await expect(await call(u, "/night-audit/current"), 403);
  let a = await get();
  ok(a.snapshot.receipt_totals.find(t => t.currency === "LKR").amount === 5000, "Local-date receipts exclude next day");
  ok(a.snapshot.receipt_totals.find(t => t.currency === "USD").amount === 20, "No currency mixing");
  ok(a.snapshot.charge_totals[0].amount === 14300 && a.snapshot.charges.some(c => c.day_use), "Tax and day-use allocation included exactly once");
  ok(a.snapshot.balance_totals[0].amount === 21450, "Unpaid invoices include day-use/checked-out stays");
  ok(a.snapshot.blockers.some(b => b.id.startsWith("arrival:")) && a.snapshot.blockers.some(b => b.id.startsWith("housekeeping:")), "Operational blockers visible");
  await Invoice.updateOne({ _id: invoice._id }, { $set: { status: "draft" } });
  let uncovered = await get(); const missingBill = uncovered.snapshot.blockers.find(b => b.id === `invoice:${stay._id}`);
  ok(missingBill && !missingBill.can_override, "Missing accommodation invoices require a real fix, not an override");
  await expect(await write(owner, "override", uncovered, { exception_id: missingBill.id, context_hash: missingBill.context_hash, reason: "Cannot skip missing invoiced charges" }), 409);
  await Invoice.updateOne({ _id: invoice._id }, { $set: { status: "issued" } });
  const blocked = await expect(await write(desk, "run", a, { confirmed: true })); ok(blocked.outcome === "blocked" && await Report.countDocuments({ property_id: propertyId }) === 0, "Preflight stops before posting/reports");
  ok((await Reservation.findById(missing._id)).status === "confirmed", "No automatic no-show or fee");
  await expect(await write(finance, "run", a, { confirmed: true }), 403);
  await expect(await write(owner, "complete", a, {}), 403); // retired route cannot bypass checks
  await expect(await write(desk, "override", a, { exception_id: a.snapshot.blockers[0].id, reason: "Not authorized override" }), 403);
  await expect(await call(finance, `/night-audit/${a._id}/finance-review`, "POST", { version: a.version, status: "reviewed", confirmed: true }), 409);
  let entries = a.snapshot.receipt_groups.map(g => ({ key: g.key, actual: g.expected, note: "External receipt checked", confirmed: true }));
  await expect(await write(desk, "reconciliation", a, { fingerprint: "stale", entries }), 409);
  await expect(await write(desk, "reconciliation", a, { fingerprint: a.snapshot.payment_fingerprint, entries: entries.map(e => ({ ...e, confirmed: false })) }), 400);
  a = (await expect(await write(desk, "reconciliation", a, { fingerprint: a.snapshot.payment_fingerprint, entries }))).night_audit;
  ok(a.snapshot.receipt_groups.every(g => g.verification), "Actual receipt checks recorded");
  // New receipts invalidate previous verification even if the operator has a stale page.
  const extra = await pay(100, "LKR", "cash", "2026-11-10T12:00:00Z");
  let fresh = await get(); ok(fresh.snapshot.blockers.some(i => i.id.startsWith("payment:")), "New payment invalidates stale receipt checks");
  await expect(await write(desk, "reconciliation", a, { fingerprint: a.snapshot.payment_fingerprint, entries }), 409);
  entries = fresh.snapshot.receipt_groups.map(g => ({ key: g.key, actual: g.method === "cash" ? g.expected - 50 : g.expected, note: "Cash count differs by fifty", confirmed: true }));
  a = (await expect(await write(desk, "reconciliation", fresh, { fingerprint: fresh.snapshot.payment_fingerprint, entries }))).night_audit;
  const diff = a.snapshot.blockers.find(b => b.id.startsWith("payment-difference:")); ok(Boolean(diff), "Receipt mismatch blocks close");
  a = (await expect(await write(admin, "override", a, { exception_id: diff.id, context_hash: diff.context_hash, reason: "Cash variance investigated and accepted by Admin" }))).night_audit;
  ok(!a.snapshot.blockers.some(b => b.id === diff.id), "Owner/Admin can document a discrepancy exception");
  const hk = a.snapshot.blockers.find(b => b.id.startsWith("housekeeping:"));
  a = (await expect(await write(owner, "override", a, { exception_id: hk.id, context_hash: hk.context_hash, reason: "Room remains unsold until cleaning tomorrow" }))).night_audit;
  ok((await Room.findById(type._id)).physical_rooms[1].housekeeping_status === "dirty", "Override does not pretend the room is clean");
  await Reservation.updateOne({ _id: missing._id }, { $set: { status: "no_show" } });
  a = await get(); ok(a.snapshot.blockers.length === 0, "All required exceptions resolved or specifically approved");
  // Deliberately fail report generation inside the transaction: no close or partial pack survives.
  const createReports = Report.create; let reportsAttempted = 0;
  Report.create = async function (...args) { if (++reportsAttempted === 3) throw new Error("Injected report failure"); return createReports.apply(this, args); };
  try { await expect(await write(desk, "run", a, { confirmed: true }), 500); } finally { Report.create = createReports; }
  ok(await Report.countDocuments({ property_id: propertyId }) === 0 && (await Night.findById(a._id)).status === "open", "Mid-run failure rolls back every report and close");
  ok((await Property.findOne({ property_id: propertyId })).business_date.toISOString().startsWith("2026-11-10"), "Failed attempt does not advance day");
  const closed = await Promise.all([write(desk, "run", a, { confirmed: true, close_note: "Handover checked" }), write(owner, "run", a, { confirmed: true })]);
  ok(JSON.stringify(closed.map(r => r.status).sort()) === "[200,409]", "Concurrent run closes exactly once");
  a = (await expect(await call(finance, `/night-audit/${a._id}`))).night_audit;
  ok(a.status === "closed" && a.next_business_date === "2026-11-11" && a.finance_review_status === "pending_review", "New day opens before Finance review");
  ok(await Report.countDocuments({ property_id: propertyId, night_audit_id: a._id }) === 6, "Six frozen reports saved once");
  ok(await Transaction.countDocuments({ property_id: propertyId }) === 0, "Audit creates no cash or duplicate revenue transaction");
  ok((await Invoice.findById(invoice._id)).grand_total === 14300 && (await Invoice.findById(dayInvoice._id)).grand_total === 7150, "Guest bills not inflated");
  const stored = await expect(await call(finance, `/night-audit/${a._id}/reports/${a.reports[1].report_run_id}`));
  ok(stored.report.rows.length === 3, "Reports contain frozen rows, not regenerated current figures");
  await Payment.deleteOne({ _id: extra._id });
  const storedAgain = await expect(await call(admin, `/night-audit/${a._id}/reports/${a.reports[1].report_run_id}`)); ok(storedAgain.report.rows.length === 3, "Later payment changes cannot rewrite frozen report");
  await expect(await call(desk, `/night-audit/${a._id}/finance-review`, "POST", { status: "reviewed", version: a.version, confirmed: true }), 403);
  let reviewed = (await expect(await call(owner, `/night-audit/${a._id}/finance-review`, "POST", { status: "reviewed", version: a.version, confirmed: true, note: "Owner reviewed saved reports" }))).night_audit;
  ok(reviewed.finance_reviewed_by.user_id === String(owner._id), "Owner verification uses verified identity, ignores forged headers");
  await expect(await call(admin, `/night-audit/${a._id}/finance-review`, "POST", { status: "reviewed", version: a.version, confirmed: true }), 409);
  reviewed = (await expect(await call(finance, `/night-audit/${a._id}/finance-review`, "POST", { status: "flagged", version: reviewed.version, confirmed: true, note: "Investigate approved cash discrepancy" }))).night_audit;
  ok(reviewed.finance_review_history.length === 2 && reviewed.status === "closed", "Finance flags without reopening or rewriting close; prior review retained");
  reviewed = (await expect(await call(admin, `/night-audit/${a._id}/finance-review`, "POST", { status: "reviewed", version: reviewed.version, confirmed: true, note: "Admin verified follow-up" }))).night_audit;
  ok(reviewed.finance_review_history.length === 3, "Admin can verify too");
  await expect(await write(desk, "run", a, { confirmed: true }), 409);
  await Property.updateOne({ property_id: propertyId }, { $set: { "staff_roles.0.run_night_audit": false } });
  await expect(await call(desk, "/night-audit/current"), 403);
  ok((await Audit.find({ property_id: propertyId, action: "night_audit_completed" })).length === 1, "One completion audit record");
  // A previous workflow's open-day artificial inflow is voided, not overwritten.
  let second = (await expect(await call(admin, "/night-audit/current"))).night_audit;
  await Room.updateOne({ _id: type._id }, { $set: { "physical_rooms.1.housekeeping_status": "clean" } });
  const { postFinancialTransaction } = require("../services/financial-transaction.service");
  const oldTx = await postFinancialTransaction({ propertyId, sourceType: "night_audit", sourceId: second._id, sourceNumber: "NA-LEGACY", description: "Disposable old workflow cash artifact", amount: 6500, direction: "in", accountingEffect: "increase", currency: "LKR", actor: { user_id: String(owner._id), name: owner.name }, transactionDate: "2026-11-11" });
  await Night.updateOne({ _id: second._id }, { $set: { workflow_version: 1, revenue_transaction_id: oldTx._id } });
  second = (await expect(await call(admin, "/night-audit/current"))).night_audit;
  ok(second.snapshot.legacy_posting && second.snapshot.receipt_totals[0].amount === 777, "Legacy artificial inflow excluded from real receipt totals");
  const secondEntries = second.snapshot.receipt_groups.map(g => ({ key: g.key, actual: g.expected, note: "Next day receipts checked", confirmed: true }));
  second = (await expect(await write(admin, "reconciliation", second, { fingerprint: second.snapshot.payment_fingerprint, entries: secondEntries }))).night_audit;
  second = (await expect(await write(admin, "run", second, { confirmed: true }))).night_audit;
  ok(second.status === "closed" && (await Transaction.findById(oldTx._id)).status === "voided", "Legacy open-day batch voided with history, no replacement cash entry");
  ok(await Transaction.countDocuments({ property_id: propertyId }) === 1, "No new revenue/cash row during legacy replacement");
  await Property.updateOne({ property_id: propertyId }, { $set: { business_date: "2099-01-01" } });
  const future = (await expect(await call(admin, "/night-audit/current"))).night_audit;
  await expect(await write(admin, "run", future, { confirmed: true }), 409);
  console.log(`PASS: ${checks} authenticated MongoDB/API checks: blockers, no-show decisions, actual receipts, timezone/currencies, day-use/tax, frozen reports, transaction rollback, concurrency, no duplicate billing/cash, Owner/Admin/Finance reviews and permission revocation.`);
}
main().catch(e => { console.error(`FAIL after ${checks} checks: ${e.message.slice(0, 1600)}\n${e.stack?.split("\n").find(l => l.includes("live-night-audit-v2")) || ""}`); process.exitCode = 1; }).finally(async () => {
  try { if (server) await new Promise(r => server.close(r)); if (mongoose.connection.readyState === 1) {
    assert.ok(propertyId.startsWith("night-v2-"));
    for (const model of [Report, Audit, Transaction, Reservation, Room, Night, Property, Invoice, Payment, Counter]) { await model.deleteMany({ property_id: propertyId }); assert.equal(await model.countDocuments({ property_id: propertyId }), 0); }
    await Guard.deleteMany({ _id: propertyId }); await User.deleteMany({ _id: { $in: ids }, email: { $regex: `^${propertyId}-` } }); assert.equal(await User.countDocuments({ _id: { $in: ids } }), 0);
    console.log("Disposable Night Audit V2 fixtures removed; cleanup verified.");
  } } catch (e) { console.error(`Cleanup requires inspection for ${propertyId}: ${e.message}`); process.exitCode = 1; } finally { await mongoose.disconnect(); }
});
