const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Property = require("../db_models/property.model");
const User = require("../db_models/user.model");
const RoomType = require("../db_models/rooms.model");
const AuditLog = require("../db_models/booking-log.model");
const ChannelConnectionRequest = require("../db_models/channel-connection-request.model");
const { propertyRole } = require("../services/property-access.service");
const { permissionsForRole, hasPropertyPermission } = require("../services/property-permissions.service");

function user(name, role = "user") {
  return { _id: new mongoose.Types.ObjectId(), name, email: `${name.toLowerCase()}@example.test`, role };
}

test("administrator role is property scoped, requires membership and never overrides ownership", () => {
  const owner = user("Owner"), admin = user("Admin"), other = user("Other", "admin");
  const property = { owner_id: owner._id, member_ids: [admin._id], administrator_ids: [admin._id], status: "active" };
  assert.equal(propertyRole(property, owner), "owner");
  assert.equal(propertyRole(property, admin), "administrator");
  assert.equal(propertyRole({ ...property, member_ids: [] }, admin), null);
  assert.equal(propertyRole({ ...property, owner_id: admin._id }, admin), "owner");
  assert.equal(propertyRole({ ...property, status: "inactive" }, admin), null);
  assert.equal(propertyRole(property, other), null, "global admin does not grant access to another owner's hotel");
  assert.equal(hasPropertyPermission("administrator", "staff.manage"), true);
  assert.equal(hasPropertyPermission("administrator", "subscription.manage"), false);
  assert.equal(hasPropertyPermission("administrator", "administrators.manage"), false);
  assert.equal(hasPropertyPermission("owner", "administrators.manage"), true);
  assert.deepEqual(permissionsForRole("unknown"), []);
  assert.deepEqual(permissionsForRole("__proto__"), []);
  const copy = permissionsForRole("administrator"); copy.push("subscription.manage");
  assert.equal(hasPropertyPermission("administrator", "subscription.manage"), false);
});

test("administrator membership validation rejects orphaned grants", async () => {
  const admin = user("Admin");
  const property = new Property({ property_id: "hotel-validation", administrator_ids: [admin._id],
    info: { hotel_name: "Validation Hotel", address: "Test Street", country_code: "LK", email: "hotel@example.test" } });
  await assert.rejects(property.validate(), /Administrators must be non-owner property members/);
  property.member_ids = [admin._id];
  await property.validate();
  property.owner_id = admin._id;
  await assert.rejects(property.validate(), /Administrators must be non-owner property members/);
});

function query(value) {
  return { select() { return this; }, lean() { return this; }, sort() { return this; }, session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}

test("Owner/Admin HTTP access, role changes, revocation and owner-only settings", async (t) => {
  process.env.JWT_SECRET = "isolated-owner-admin-tests";
  const owner = user("Owner"), admin = user("Admin"), staff = user("Staff"), newcomer = user("Newcomer"), outsider = user("Outsider", "admin");
  const users = [owner, admin, staff, newcomer, outsider];
  const records = new Map();
  function put(property) { records.set(property.property_id, property.toObject()); }
  put(new Property({ property_id: "hotel-one", owner_id: owner._id, member_ids: [admin._id, staff._id], administrator_ids: [admin._id],
    info: { hotel_name: "First Hotel", address: "Test Street", country_code: "LK", email: "first@example.test", plan: "Starter", on_trial: false } }));
  put(new Property({ property_id: "hotel-two", owner_id: outsider._id, member_ids: [admin._id],
    info: { hotel_name: "Second Hotel", address: "Test Street", country_code: "LK", email: "second@example.test" } }));
  put(new Property({ property_id: "hotel-legacy",
    info: { hotel_name: "Legacy Hotel", address: "Test Street", country_code: "LK", email: "legacy@example.test" } }));
  t.mock.method(User, "findById", (id) => query(users.find((item) => String(item._id) === String(id))));
  t.mock.method(User, "findOne", (filter) => query(users.find((item) => item.email === filter.email)));
  t.mock.method(User, "find", (filter) => query(users.filter((item) => filter._id.$in.some((id) => String(id) === String(item._id)))));
  t.mock.method(Property, "findOne", (filter) => query(records.has(filter.property_id) ? new Property(records.get(filter.property_id)) : null));
  t.mock.method(Property, "find", (filter) => query([...records.values()].filter((property) => filter.$or.some((condition) =>
    "owner_id" in condition ? String(property.owner_id) === String(condition.owner_id) : property.member_ids.some((id) => String(id) === String(condition.member_ids))))
    .map((property) => new Property(property))));
  t.mock.method(Property.prototype, "save", async function () { await this.validate(); put(this); return this; });
  t.mock.method(RoomType, "find", () => query([]));
  t.mock.method(ChannelConnectionRequest, "find", () => ({ sort() { return this; }, limit() { return this; }, lean() { return Promise.resolve([]); } }));
  const audits = [];
  t.mock.method(AuditLog, "create", async (values) => { audits.push(...values); return values; });
  t.mock.method(require("../db_models/inventory-guard.model"), "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (work) => work(), endSession: async () => {} }));
  const { app } = require("../app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (actor, route, method = "GET", body) => fetch(`${base}${route}`, { method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const access = "/properties/hotel-one/access";
  const ownAccess = await (await request(admin, "/properties/hotel-one/my-access")).json();
  assert.equal(ownAccess.role, "administrator");
  assert.ok(ownAccess.permissions.includes("channels.manage"));
  assert.ok(!ownAccess.permissions.includes("subscription.manage"));
  const properties = (await (await request(admin, "/properties")).json()).properties;
  assert.equal(properties.find((item) => item.property_id === "hotel-one").role, "administrator");
  assert.equal(properties.find((item) => item.property_id === "hotel-two").role, "member");
  assert.equal((await request(admin, "/properties/hotel-one")).status, 200);
  assert.equal((await request(admin, access)).status, 200);
  assert.equal((await request(admin, "/channel-requests?property_id=hotel-one")).status, 200);
  assert.equal((await request(staff, "/channel-requests?property_id=hotel-one")).status, 403);
  assert.equal((await request(admin, "/properties/hotel-two/access")).status, 403);
  assert.equal((await request(staff, access)).status, 403);
  assert.equal((await request(outsider, access)).status, 403);
  assert.equal((await request(staff, access, "POST", { email: staff.email, role: "administrator" })).status, 403);
  assert.equal((await request(admin, access, "POST", { email: newcomer.email, role: "administrator" })).status, 403);
  assert.equal((await request(admin, `${access}/${owner._id}`, "DELETE")).status, 400);
  assert.equal((await request(admin, `${access}/${admin._id}`, "DELETE")).status, 403);
  assert.equal((await request(admin, `${access}/${staff._id}`, "PATCH", { role: "administrator" })).status, 403);
  assert.equal((await request(owner, `${access}/${owner._id}`, "PATCH", { role: "member" })).status, 400);
  assert.equal((await request(owner, access, "POST", { email: newcomer.email, role: "owner" })).status, 400);
  assert.equal((await request(owner, access, "POST", { email: newcomer.email, role: "manager" })).status, 400);
  assert.equal((await request(owner, access, "POST", { email: { $ne: "" } })).status, 400);
  assert.equal((await request(outsider, "/properties/hotel-legacy/access", "POST", { email: outsider.email, role: "administrator" })).status, 400,
    "legacy effective owners cannot accidentally replace their own owner access");
  assert.equal((await request(owner, `${access}/not-an-id`, "PATCH", { role: "administrator" })).status, 400);

  assert.equal((await request(admin, access, "POST", { email: newcomer.email })).status, 201);
  assert.equal((await request(newcomer, "/properties/hotel-one/my-access")).status, 200);
  assert.equal((await request(owner, `${access}/${newcomer._id}`, "PATCH", { role: "administrator" })).status, 200);
  assert.equal((await (await request(newcomer, "/properties/hotel-one/my-access")).json()).role, "administrator");
  assert.equal((await request(admin, `${access}/${newcomer._id}`, "DELETE")).status, 403);
  assert.equal((await request(admin, access, "POST", { email: newcomer.email })).status, 403, "grant cannot silently demote another admin");
  assert.equal((await request(owner, `${access}/${newcomer._id}`, "PATCH", { role: "member" })).status, 200);
  assert.equal((await request(newcomer, access)).status, 403, "role change takes effect with the same login token");
  assert.equal((await request(admin, `${access}/${newcomer._id}`, "DELETE")).status, 200);
  assert.equal((await request(newcomer, "/properties/hotel-one")).status, 403);
  assert.equal((await request(owner, `${access}/${newcomer._id}`, "PATCH", { role: "administrator" })).status, 404, "cannot promote a revoked account");

  const settings = "/properties/hotel-one/info";
  assert.equal((await request(admin, settings, "PATCH", { info: { plan: "Portfolio" } })).status, 403);
  assert.equal((await request(admin, settings, "PATCH", { info: { on_trial: true } })).status, 403);
  assert.equal((await request(staff, settings, "PATCH", { plan: "Portfolio" })).status, 403);
  assert.equal((await request(admin, settings, "PATCH", { info: { plan: "Starter", on_trial: false, hotel_name: "Updated Hotel" } })).status, 200,
    "unchanged owner-only fields do not block ordinary full-form saves");
  assert.equal((await request(owner, settings, "PATCH", { info: { plan: "Growth" } })).status, 200);
  assert.equal(records.get("hotel-one").info.plan, "Growth");
  assert.equal((await request(owner, settings, "PATCH", { owner_id: admin._id })).status, 400);
  assert.equal((await request(admin, settings, "PATCH", { info: { administrator_ids: [admin._id] } })).status, 400);
  assert.equal(String(records.get("hotel-one").owner_id), String(owner._id));

  const stayTimes = {
    check_in_time_from: "18:00",
    check_in_time_to: "12:00",
    check_out_time_from: "05:00",
    check_out_time_to: "08:00"
  };
  const savedTimes = await request(admin, settings, "PATCH", { info: stayTimes });
  assert.equal(savedTimes.status, 200, await savedTimes.clone().text());
  const savedProperty = (await savedTimes.json()).property;
  for (const [field, time] of Object.entries(stayTimes)) {
    assert.equal(savedProperty.info[field], time);
    assert.equal(records.get("hotel-one").info[field], time);
  }
  assert.equal(savedProperty.info.check_in_time, "18:00", "older clients receive the current From time");
  const reopened = (await (await request(owner, "/properties/hotel-one")).json()).property;
  assert.equal(reopened.info.check_in_time_to, "12:00");
  assert.equal(reopened.info.check_out_time_to, "08:00");
  assert.ok(audits.some(item => item.action === "property_info_updated" &&
    item.actor.user_id === String(admin._id) &&
    item.changes.some(change => change.field === "info.check_in_time_to" && change.to === "12:00")));
  assert.equal((await request(owner, settings, "PATCH", { info: { check_in_time_to: "25:00" } })).status, 400);
  assert.equal((await request(owner, settings, "PATCH", { info: { check_out_time_from: "" } })).status, 400);
  assert.equal((await request(outsider, settings, "PATCH", { info: stayTimes })).status, 403);
  assert.equal(records.get("hotel-one").info.check_in_time_to, "12:00", "invalid updates preserve saved ranges");
  const legacySave = await request(owner, settings, "PATCH", {
    info: { check_in_time: "17:00", check_in_time_from: "19:00", check_out_time: "06:00" }
  });
  assert.equal(legacySave.status, 200);
  assert.equal(records.get("hotel-one").info.check_in_time_from, "19:00", "explicit From takes precedence");
  assert.equal(records.get("hotel-one").info.check_out_time_from, "06:00");
  assert.equal(records.get("hotel-one").info.check_out_time_to, "08:00", "partial updates preserve the To time");

  const members = (await (await request(owner, access)).json()).members;
  assert.equal(members.find((item) => item.id === String(admin._id)).role, "administrator");
  assert.equal(members.find((item) => item.id === String(owner._id)).role, "owner");
  assert.ok(audits.some((item) => item.action === "property_role_changed" && item.actor.user_id === String(owner._id)));
  assert.ok(audits.some((item) => item.action === "property_access_revoked" && item.actor.user_id === String(admin._id)));
  assert.equal((await request(owner, `${access}/${admin._id}`, "DELETE")).status, 200);
  assert.equal((await request(admin, "/properties/hotel-one")).status, 403);
  assert.equal((await request(admin, "/properties/hotel-two")).status, 200, "revocation is property specific");
});
