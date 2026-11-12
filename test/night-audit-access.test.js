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
