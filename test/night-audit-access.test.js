const test = require("node:test"), assert = require("node:assert/strict"), mongoose = require("mongoose");
const { permissionsForProperty, authorizePropertyRequest } = require("../services/property-permissions.service");
const Property = require("../db_models/property.model"), NightAudit = require("../db_models/night-audit.model");
function allowed(role, path, method = "GET", permissions = []) {
  let passed = false;
  authorizePropertyRequest({ propertyRole: role, propertyPermissions: permissions, path, method }, { status() { return this; }, json() {} }, () => { passed = true; });
  return passed;
}
test("Night Audit delegation is property-scoped, Front Desk only and off by default", async () => {
  const user = new mongoose.Types.ObjectId();
  const property = new Property({ property_id: "night-audit-access", member_ids: [user], staff_roles: [{ user_id: user, role: "front_desk" }], info: { hotel_name: "Test", address: "Road", email: "a@example.test", country_code: "LK" } });
  assert.equal(permissionsForProperty("front_desk", property, user).includes("night-audit.run"), false);
  property.staff_roles[0].run_night_audit = true;
  await property.validate();
  assert.ok(permissionsForProperty("front_desk", property, user).includes("night-audit.run"));
  assert.equal(permissionsForProperty("front_desk", property, new mongoose.Types.ObjectId()).includes("night-audit.run"), false);
  property.staff_roles[0].role = "finance";
  await assert.rejects(property.validate(), /Only Front Desk/);
});
test("Audit execution, overrides and Finance review have separate server permissions", () => {
  const id = String(new mongoose.Types.ObjectId());
  for (const role of ["owner", "administrator"]) {
    assert.ok(allowed(role, "/night-audit/current/run", "POST"));
    assert.ok(allowed(role, "/night-audit/current/override", "POST"));
    assert.equal(allowed(role, `/night-audit/${id}/finance-review`, "POST"), true);
  }
  assert.equal(allowed("front_desk", "/night-audit/current"), false);
  assert.ok(allowed("front_desk", "/night-audit/current/run", "POST", ["night-audit.run"]));
  assert.equal(allowed("front_desk", "/night-audit/current/override", "POST", ["night-audit.run"]), false);
  assert.ok(allowed("finance", `/night-audit/${id}/finance-review`, "POST"));
  assert.equal(allowed("finance", "/night-audit/current/complete", "POST"), false);
  for (const role of ["member", "housekeeping", "demo"]) assert.equal(allowed(role, "/night-audit/current/complete", "POST", ["night-audit.run"]), false);
});
test("Finance review status is separate from audit close status", async () => {
  const audit = new NightAudit({ property_id: "test", business_date: "2026-10-30" });
  assert.equal(audit.finance_review_status, "pending_review");
  audit.status = "closed"; audit.closed_at = new Date(); audit.next_business_date = new Date("2026-10-31");
  await audit.validate();
  audit.finance_review_status = "flagged"; audit.finance_review_history.push({ status: "flagged", note: "Check receipts", actor: { name: "Finance" }, at: new Date() });
  await audit.validate();
  assert.equal(audit.status, "closed"); assert.equal(audit.next_business_date.toISOString().slice(0, 10), "2026-10-31");
});

test("saving a follow-up Night Audit verification requires a reason and keeps the prior review", async t => {
  const express = require("express");
  const Property = require("../db_models/property.model");
  const AuditLog = require("../db_models/booking-log.model");
  const financeId = new mongoose.Types.ObjectId();
  const property = { property_id: "verification-test", status: "active", member_ids: [financeId], staff_roles: [{ user_id: financeId, role: "finance" }] };
  const audit = new NightAudit({ property_id: property.property_id, business_date: "2026-10-30",
    status: "closed", closed_at: new Date("2026-10-31T00:30:00Z"), next_business_date: "2026-10-31", close_summary: { receipt_totals: [] }, version: 0 });
  const query = record => ({ session: async () => record });
  t.mock.method(Property, "findOne", () => query(property));
  t.mock.method(NightAudit, "findOne", () => query(audit));
  t.mock.method(audit, "save", async () => { await audit.validate(); audit.version++; return audit; });
  t.mock.method(require("../services/inventory-transaction.service"), "withInventoryTransaction", (_id, work) => work(null));
  const entries = [];
  t.mock.method(AuditLog, "create", async ([entry]) => {
    const log = new AuditLog(entry);
    await log.validate();
    entries.push(log);
    return [log];
  });

  const app = express();
  app.use(express.json(), (req, _res, next) => {
    req.authorizedProperty = property;
    req.workspaceUser = { _id: financeId };
    next();
  });
  app.use("/night-audit", require("../routes/night-audit-v2"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const verify = (version, note, status = "reviewed") => fetch(`http://127.0.0.1:${server.address().port}/night-audit/${audit.id}/finance-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-id": String(financeId), "x-user-name": "Test Finance" },
    body: JSON.stringify({ version, status, note, confirmed: true })
  });

  assert.equal((await verify(0, "", "flagged")).status, 400);
  const first = await verify(0, "");
  assert.equal(first.status, 200, await first.text());
  const rejected = await verify(1, "  ");
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).message, /follow-up reason/);
  assert.equal(entries.length, 1);
  const flagged = await verify(1, "Receipt needs investigation", "flagged");
  assert.equal(flagged.status, 200);
  const longReason = "Reviewed after checking the receipt. ".repeat(70).trim();
  const reviewed = await verify(2, longReason);
  assert.equal(reviewed.status, 200);
  const { night_audit: saved } = await reviewed.json();
  assert.deepEqual(saved.finance_review_history.map(review => review.status), ["reviewed", "flagged", "reviewed"]);
  assert.equal(saved.finance_review_note, longReason);
  assert.equal(saved.status, "closed");
  assert.deepEqual(saved.snapshot, { receipt_totals: [] });
  assert.equal(entries.length, 3);
});
