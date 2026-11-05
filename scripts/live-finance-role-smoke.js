// Isolated acceptance check. Creates only disposable records and removes them.
require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict"), crypto = require("node:crypto"), mongoose = require("mongoose"), jwt = require("jsonwebtoken");
const User = require("../db_models/user.model"), Property = require("../db_models/property.model"), RoomType = require("../db_models/rooms.model"), Reservation = require("../db_models/booking.model"), Guest = require("../db_models/guest.model");
const Invoice = require("../db_models/invoice.model"), Payment = require("../db_models/reservation-payment.model"), Credit = require("../db_models/credit-note.model"), Refund = require("../db_models/refund.model"), Withdrawal = require("../db_models/withdrawal.model"), Purchase = require("../db_models/purchase.model"), Expense = require("../db_models/expense.model"), Transaction = require("../db_models/financial-transaction.model"), Counter = require("../db_models/document-counter.model"), Audit = require("../db_models/booking-log.model"), Guard = require("../db_models/inventory-guard.model"), Report = require("../db_models/reports.model"), ReadState = require("../db_models/notification-read-state.model");
const propertyId = `finance-smoke-${crypto.randomBytes(6).toString("hex")}`, userIds = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
let server, checks = 0;
async function main() {
  await mongoose.connect(process.env.mongoURI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const [owner, finance, outsider] = await User.create(userIds.map((_id, index) => ({ _id, name: `Finance Smoke ${index}`, email: `${propertyId}-${index}@example.test`, password: "disposable-no-login", mobile: "0771234567" })));
  await Property.create({ property_id: propertyId, owner_id: owner._id, info: { hotel_name: propertyId, address: "Disposable fixture", email: "h@example.test", country_code: "LK" } });
  const guest = await Guest.create({ property_id: propertyId, name: "Disposable Finance Guest", phone: "0771234567", email: "guest@example.test", country: "Sri Lanka" });
  const type = await RoomType.create({ property_id: propertyId, name: "Smoke Standard", maximum_adults: 2, maximum_children: 0, base_rate: 5000, currency: "LKR", physical_rooms: [{ room_number: "F101", active: true, operational_status: "available", housekeeping_status: "clean" }] });
  const booking = await Reservation.create({ property_id: propertyId, reservation_no: `${propertyId}-RES`, check_in: new Date("2026-12-10"), check_out: new Date("2026-12-11"), status: "confirmed", currency: "LKR", booking_source: "Direct", internal_remarks: "PRIVATE-OPERATIONS-NOTE",
    booker: { name: guest.name, phone: guest.phone, email: guest.email, country: guest.country, guest_profile_id: guest._id }, rooms: [{ room_type_id: type._id, room_type_name: type.name, physical_room_id: type.physical_rooms[0]._id, room_number: "F101", adults: 2, children: 0, original_nightly_rate: 5000, effective_nightly_rate: 5000 }] });
  const { app } = require("../app"); server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const call = (actor, path, method = "GET", body) => fetch(`http://127.0.0.1:${server.address().port}/api${path}${method === "GET" ? `${path.includes("?") ? "&" : "?"}property_id=${propertyId}` : ""}`, { method, headers: { Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET, { expiresIn: "10m" })}`, "Content-Type": "application/json", "x-user-id": String(owner._id) }, ...(method !== "GET" ? { body: JSON.stringify({ property_id: propertyId, ...body }) } : {}) });
  const expect = async (response, status) => { assert.equal(response.status, status, await response.clone().text()); checks++; return response.json(); };
  await expect(await call(finance, "/invoices"), 403);
  await expect(await call(owner, `/properties/${propertyId}/access`, "POST", { email: finance.email, role: "finance" }), 201);
  const access = await expect(await call(finance, `/properties/${propertyId}/my-access`), 200); assert.equal(access.role, "finance"); checks++;
  const bill = await expect(await call(finance, "/bookings/reservations?details=true"), 200); assert.ok(!JSON.stringify(bill).includes("PRIVATE-OPERATIONS-NOTE")); checks++;
  await expect(await call(finance, "/bookings/reservations", "POST", {}), 403);
  const created = await expect(await call(finance, "/invoices", "POST", { reservation_id: booking._id, status: "issued" }), 201); assert.equal(created.invoice.status, "draft"); assert.equal(created.invoice.grand_total, 5000); checks++;
  await expect(await call(finance, `/invoices/${created.invoice._id}/issue`, "POST", {}), 200);
  const paid = await expect(await call(finance, `/invoices/${created.invoice._id}/payments`, "POST", { amount: 5000, payment_method: "cash" }), 201);
  await expect(await call(finance, `/invoices/${created.invoice._id}/payments/${paid.payment._id}/void`, "POST", { reason: "Forbidden correction" }), 403);
  const credit = await expect(await call(finance, "/credits", "POST", { invoice_id: created.invoice._id, reason_code: "rate_correction", reason: "Disposable credit review", line_items: [{ invoice_line_id: created.invoice.line_items[0]._id, category: "accommodation", description: "Rate correction", quantity: 1, unit_amount: 500, tax_amount: 0 }], status: "issued" }), 201); assert.equal(credit.credit.status, "draft"); checks++;
  await expect(await call(finance, `/credits/${credit.credit._id}/issue`, "POST", {}), 403);
  await expect(await call(owner, `/credits/${credit.credit._id}/issue`, "POST", {}), 200);
  const refund = await expect(await call(finance, "/refunds", "POST", { invoice_id: created.invoice._id, payment_id: paid.payment._id, amount: 500, refund_method: "cash", reason: "Return approved credit overpayment", status: "completed" }), 201); assert.equal(refund.refund.status, "pending"); checks++;
  await expect(await call(finance, `/refunds/${refund.refund._id}/complete`, "POST", {}), 403);
  await expect(await call(owner, `/refunds/${refund.refund._id}/complete`, "POST", {}), 200);
  const date = new Date().toISOString();
  const expense = await expect(await call(finance, "/expenses", "POST", { expense_date: date, expense_type: "Electricity", paid_using: "cash", amount: 300, currency: "LKR", description: "Disposable electricity record" }), 201);
  const purchase = await expect(await call(finance, "/purchases", "POST", { purchase_date: date, due_date: date, supplier_name: "Disposable supplier", supplier_invoice_no: propertyId, amount: 700, currency: "USD", narration: "Disposable supplier balance" }), 201);
  const overview = await expect(await call(finance, "/finance/overview"), 200); assert.equal(overview.currencies.find(row => row.currency === "LKR").collected, 5000); assert.equal(overview.currencies.find(row => row.currency === "USD").payables, 700); checks++;
  await expect(await call(finance, `/purchases/${purchase.purchase._id}/pay`, "POST", {}), 200);
  await expect(await call(finance, `/expenses/${expense.expense._id}/void`, "POST", { reason: "Forbidden correction" }), 403);
  const pending = await expect(await call(finance, "/withdrawals", "POST", { recipient_user_id: String(owner._id), amount: 2500, currency: "LKR", source_account: "cash_on_hand", payment_method: "cash", reason: "Disposable Finance withdrawal request", money_received_at: date, status: "completed", approved_by: owner }), 201);
  assert.equal(pending.withdrawal.status, "pending"); assert.equal(pending.withdrawal.effective_amount, 0); assert.equal(await Transaction.countDocuments({ property_id: propertyId, source_type: "withdrawal" }), 0); checks++;
  await expect(await call(finance, `/withdrawals/${pending.withdrawal._id}/complete`, "POST", { version: pending.withdrawal.version, note: "Forged approval", money_received_at: date }), 403);
  const approvals = await Promise.all([1, 2].map(() => call(owner, `/withdrawals/${pending.withdrawal._id}/complete`, "POST", { version: pending.withdrawal.version, note: "Verified disposable withdrawal receipt", money_received_at: date })));
  assert.deepEqual(approvals.map(response => response.status).sort(), [200, 409]); assert.equal(await Transaction.countDocuments({ property_id: propertyId, source_type: "withdrawal", status: "posted" }), 1); checks++;
  const approved = await expect(await call(finance, `/withdrawals/${pending.withdrawal._id}`), 200); assert.equal(approved.withdrawal.approved_by.user_id, String(owner._id)); assert.equal(approved.withdrawal.effective_amount, 2500); checks++;
  const catalog = await expect(await call(finance, "/reports/catalog"), 200); assert.equal(catalog.reports.length, 8); checks++;
  await expect(await call(finance, "/reports/generate", "POST", { report_type: "collection-report", parameters: { date_from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), date_to: date.slice(0, 10), as_of: date.slice(0, 10) } }), 200);
  await expect(await call(finance, "/reports/generate", "POST", { report_type: "information-sheet", parameters: {} }), 403);
  await expect(await call(finance, "/night-audit/current/complete", "POST", {}), 403);
  await expect(await call(outsider, "/finance/overview"), 403);
  await expect(await call(owner, `/properties/${propertyId}/access/${finance._id}`, "DELETE", {}), 200);
  await expect(await call(finance, "/invoices"), 403);
  console.log(`PASS: ${checks} MongoDB Finance checks: role grants/revocation, billing privacy, invoice/payment/credit/refund flows, expenses/purchases, currency separation, guarded withdrawal approval concurrency and report restrictions.`);
}
main().catch(failure => { console.error(`FAIL: Finance acceptance (${failure.name}) after ${checks} checks. No connection credentials are printed.`); if (failure.name === "AssertionError") console.error(failure.message.slice(0, 1200), failure.stack.split("\n").find(line => line.includes("live-finance-role-smoke.js:"))); process.exitCode = 1; }).finally(async () => {
  try { if (server) await new Promise(resolve => server.close(resolve)); if (mongoose.connection.readyState === 1) {
    for (const model of [ReadState, Report, Audit, Transaction, Refund, Credit, Payment, Invoice, Withdrawal, Purchase, Expense, Reservation, Guest, RoomType, Counter, Property]) await model.deleteMany({ property_id: propertyId });
    await Guard.deleteMany({ _id: propertyId }); await User.deleteMany({ _id: { $in: userIds } });
    for (const model of [Property, Invoice, Withdrawal, Transaction, Report, Guest]) assert.equal(await model.countDocuments({ property_id: propertyId }), 0);
    assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0);
    console.log("Disposable Finance accounts, hotel, billing documents, money records, reports, counters, guard and audits removed; cleanup verified.");
  } } catch { console.error(`Cleanup needs inspection for ${propertyId}.`); process.exitCode = 1; } finally { await mongoose.disconnect(); }
});
