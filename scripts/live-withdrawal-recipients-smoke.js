// Creates disposable accounts and hotels only, then verifies cleanup.
require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict"), mongoose = require("mongoose"), crypto = require("node:crypto"), jwt = require("jsonwebtoken");
const Property = require("../db_models/property.model"), User = require("../db_models/user.model"), Withdrawal = require("../db_models/withdrawal.model"), Transaction = require("../db_models/financial-transaction.model"), Audit = require("../db_models/booking-log.model"), Guard = require("../db_models/inventory-guard.model"), Counter = require("../db_models/document-counter.model"), ReadState = require("../db_models/notification-read-state.model");
const propertyId = `withdraw-smoke-${crypto.randomBytes(5).toString("hex")}`, otherPropertyId = `${propertyId}-other`, ids = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
let server, checks = 0;
async function main() {
  await mongoose.connect(process.env.mongoURI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const [owner, admin, finance, desk, otherOwner] = await User.create(ids.map((_id, index) => ({ _id, name: `Withdrawal Test ${index}`, email: `${propertyId}-${index}@example.test`, password: "disposable-no-login", mobile: "0771234567" })));
  const info = { hotel_name: propertyId, address: "Disposable fixture", email: "hotel@example.test", country_code: "LK" };
  await Property.create([{ property_id: propertyId, owner_id: owner._id, member_ids: [admin._id, finance._id, desk._id], administrator_ids: [admin._id], staff_roles: [{ user_id: finance._id, role: "finance" }, { user_id: desk._id, role: "front_desk" }], info }, { property_id: otherPropertyId, owner_id: otherOwner._id, info }]);
  const { app } = require("../app"); server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const call = (actor, path, method = "GET", body = {}, hotel = propertyId) => fetch(`http://127.0.0.1:${server.address().port}/api${path}${method === "GET" ? `?property_id=${hotel}` : ""}`, { method, headers: { Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET, { expiresIn: "10m" })}`, "Content-Type": "application/json", "x-user-id": String(owner._id) }, ...(method !== "GET" ? { body: JSON.stringify({ property_id: hotel, ...body }) } : {}) });
  const expect = async (response, code) => { assert.equal(response.status, code, await response.clone().text()); checks++; return response.json(); };
  const body = { amount: 2500, currency: "LKR", source_account: "cash_on_hand", payment_method: "cash", reason: "Disposable owner withdrawal", money_received_at: new Date().toISOString() };
  const recipients = await expect(await call(finance, "/withdrawals/recipients"), 200);
  assert.deepEqual(recipients.recipients.map(item => item.role), ["owner", "administrator"]); assert.equal(recipients.recipients[0].name, owner.name); assert.ok(!JSON.stringify(recipients).includes("@")); checks++;
  await expect(await call(admin, "/withdrawals/recipients"), 200);
  await expect(await call(desk, "/withdrawals/recipients"), 403);
  await expect(await call(otherOwner, "/withdrawals/recipients"), 403);
  for (const invalid of [undefined, "invalid", String(finance._id), String(desk._id), String(otherOwner._id)]) await expect(await call(finance, "/withdrawals", "POST", { ...body, recipient_user_id: invalid }), 400);
  const pending = (await expect(await call(finance, "/withdrawals", "POST", { ...body, recipient_user_id: String(admin._id), paid_to: "ASIRI PERERA", recipient_role: "owner", status: "completed", approved_by: owner }), 201)).withdrawal;
  assert.equal(pending.status, "pending"); assert.equal(pending.paid_to, admin.name); assert.equal(pending.recipient_user_id, String(admin._id)); assert.equal(pending.recipient_role, "administrator"); assert.equal(pending.requested_by.user_id, String(finance._id)); assert.equal(pending.effective_amount, 0); assert.equal(await Transaction.countDocuments({ property_id: propertyId }), 0); checks++;
  const notice = (await expect(await call(owner, "/notifications"), 200)).notifications.find(item => item.reference === pending.withdrawal_no);
  assert.ok(notice); assert.match(notice.message, /Requested recipient/); assert.ok(notice.message.includes(admin.name)); assert.ok(notice.message.includes(finance.name)); checks++;
  const adminNotice = (await expect(await call(admin, "/notifications"), 200)).notifications.find(item => item.reference === pending.withdrawal_no); assert.ok(adminNotice); checks++;
  const deskNotices = await expect(await call(desk, "/notifications"), 200); assert.ok(!deskNotices.notifications.some(item => item.type === "withdrawal")); checks++;
  await expect(await call(finance, `/withdrawals/${pending._id}/complete`, "POST", { version: pending.version, note: "Forbidden approval", money_received_at: body.money_received_at }), 403);
  const approvals = await Promise.all([owner, admin].map(actor => call(actor, `/withdrawals/${pending._id}/complete`, "POST", { version: pending.version, note: "Cash received by selected recipient", money_received_at: body.money_received_at })));
  assert.deepEqual(approvals.map(result => result.status).sort(), [200, 409]); checks++;
  assert.equal(await Transaction.countDocuments({ property_id: propertyId, source_type: "withdrawal", source_id: pending._id }), 1); checks++;
  const completed = (await expect(await call(finance, `/withdrawals/${pending._id}`), 200)).withdrawal; assert.equal(completed.paid_to, admin.name); assert.ok([String(owner._id), String(admin._id)].includes(completed.approved_by.user_id)); checks++;
  await User.updateOne({ _id: admin._id }, { $set: { name: "Renamed Disposable Administrator" } });
  assert.equal((await expect(await call(owner, `/withdrawals/${pending._id}`), 200)).withdrawal.paid_to, admin.name); checks++;
  const removedRecipientRequest = (await expect(await call(finance, "/withdrawals", "POST", { ...body, recipient_user_id: String(admin._id) }), 201)).withdrawal;
  assert.equal(removedRecipientRequest.paid_to, "Renamed Disposable Administrator"); checks++;
  await expect(await call(owner, `/properties/${propertyId}/access/${admin._id}`, "DELETE"), 200);
  const updatedRecipients = await expect(await call(finance, "/withdrawals/recipients"), 200); assert.equal(updatedRecipients.recipients.length, 1); checks++;
  await expect(await call(owner, `/withdrawals/${removedRecipientRequest._id}/complete`, "POST", { version: removedRecipientRequest.version, note: "Recipient no longer eligible", money_received_at: body.money_received_at }), 409);
  assert.equal((await Withdrawal.findById(removedRecipientRequest._id)).status, "pending"); checks++;
  await expect(await call(owner, `/withdrawals/${removedRecipientRequest._id}/void`, "POST", { reason: "Recipient lost property access; recreate request" }), 200);
  const direct = (await expect(await call(owner, "/withdrawals", "POST", { ...body, recipient_user_id: String(owner._id), paid_to: "FORGED PAYEE" }), 201)).withdrawal;
  assert.equal(direct.status, "completed"); assert.equal(direct.paid_to, owner.name); assert.equal(direct.recipient_role, "owner"); assert.equal(direct.approved_by.user_id, String(owner._id)); checks++;
  const [legacyPending, legacyCompleted] = await Withdrawal.create([{ ...body, property_id: propertyId, withdrawal_no: "WD-LEGACY-PENDING", paid_to: "ASIRI PERERA", status: "pending" }, { ...body, property_id: propertyId, withdrawal_no: "WD-LEGACY-COMPLETED", paid_to: "ASIRI PERERA", status: "completed" }]);
  await expect(await call(owner, `/withdrawals/${legacyPending._id}/complete`, "POST", { version: 0, note: "Cannot guess a historical recipient", money_received_at: body.money_received_at }), 409);
  assert.equal((await expect(await call(owner, `/withdrawals/${legacyCompleted._id}`), 200)).withdrawal.paid_to, "ASIRI PERERA"); checks++;
  await expect(await call(owner, `/withdrawals/${legacyPending._id}/void`, "POST", { reason: "Recreate with verified recipient" }), 200);
  await expect(await call(finance, "/withdrawals/recipients", "GET", {}, otherPropertyId), 403);
  await expect(await call(owner, `/properties/${propertyId}/access/${finance._id}`, "DELETE"), 200);
  await expect(await call(finance, "/withdrawals", "POST", { ...body, recipient_user_id: String(owner._id) }), 403);
  console.log(`PASS: ${checks} withdrawal recipient checks: property-scoped Owner/Admin options, forged names/roles rejected, pending Finance requests and notifications, approval concurrency, historical snapshots, recipient revocation, direct recording, legacy handling and staff revocation.`);
}
main().catch(error => { console.error(`FAIL: ${error.name} after ${checks} checks.`); if (error.name === "AssertionError") console.error(error.message.slice(0, 1200), error.stack.split("\n").find(line => line.includes("live-withdrawal"))); process.exitCode = 1; }).finally(async () => {
  try { if (server) await new Promise(resolve => server.close(resolve)); if (mongoose.connection.readyState === 1) { for (const model of [ReadState, Audit, Transaction, Withdrawal, Counter, Property]) { await model.deleteMany({ property_id: { $in: [propertyId, otherPropertyId] } }); assert.equal(await model.countDocuments({ property_id: { $in: [propertyId, otherPropertyId] } }), 0); } await Guard.deleteMany({ _id: { $in: [propertyId, otherPropertyId] } }); await User.deleteMany({ _id: { $in: ids } }); assert.equal(await User.countDocuments({ _id: { $in: ids } }), 0); console.log("Disposable withdrawal fixtures removed; cleanup verified."); } }
  catch { console.error(`Cleanup needs inspection for ${propertyId}.`); process.exitCode = 1; } finally { await mongoose.disconnect(); }
});
