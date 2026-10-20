const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { propertyRole, accessiblePropertiesQuery, resolveRequestPropertyId } = require("../services/property-access.service");
const User = require("../db_models/user.model");
const Session = require("../db_models/session.model");
const Property = require("../db_models/property.model");
const RoomType = require("../db_models/rooms.model");
const Guest = require("../db_models/guest.model");
const AuditLog = require("../db_models/booking-log.model");

const owner = { _id: new mongoose.Types.ObjectId(), role: "user", name: "Owner", email: "owner@example.test" };
const member = { _id: new mongoose.Types.ObjectId(), role: "user", name: "Member", email: "member@example.test" };
const outsider = { _id: new mongoose.Types.ObjectId(), role: "admin", name: "Other owner", email: "other@example.test" };

test("hotel ownership, membership, inactive hotels and legacy access", () => {
  const property = { owner_id: owner._id, member_ids: [member._id], status: "active" };
  assert.equal(propertyRole(property, owner), "owner");
  assert.equal(propertyRole(property, member), "member");
  assert.equal(propertyRole(property, outsider), null, "admin role does not bypass another hotel's ownership");
  assert.equal(propertyRole({ ...property, status: "inactive" }, owner), null);
  assert.equal(propertyRole({ status: "active" }, outsider), "owner");
  assert.equal(propertyRole({ status: "active" }, member), null);
  assert.deepEqual(accessiblePropertiesQuery(member).$or, [{ owner_id: member._id }, { member_ids: member._id }]);
});

test("conflicting property IDs and query injection are rejected", () => {
  const req = { path: "/properties/hotel-one/info", query: {}, body: {}, get: () => undefined };
  assert.equal(resolveRequestPropertyId(req), "hotel-one");
  assert.throws(() => resolveRequestPropertyId({ ...req, body: { property_id: "hotel-two" } }), /conflicting/);
  assert.throws(() => resolveRequestPropertyId({ ...req, query: { property_id: { $ne: "" } } }), /valid property/);
});

function query(value) {
  return { select() { return this; }, lean() { return this; }, sort() { return this; }, session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}

test("HTTP property creation, listing, grants, revocation and cross-hotel denial", async (t) => {
  process.env.JWT_SECRET = "isolated-property-access-test-secret";
  process.env.JWT_SECRET_REFRESH = "isolated-property-refresh-test-secret";
  const properties = [];
  const users = [owner, member, outsider];
  t.mock.method(User, "findById", (id) => query(users.find((user) => String(user._id) === String(id))));
  t.mock.method(User, "findOne", (filter) => query(users.find((user) => user.email === filter.email)));
  t.mock.method(User, "find", (filter) => query(users.filter((user) => filter._id.$in.some((id) => String(id) === String(user._id)))));
  t.mock.method(Property, "findOne", (filter) => query(properties.find((property) => property.property_id === filter.property_id) || null));
  t.mock.method(Property, "find", (filter) => query(properties.filter((property) => filter.$or.some((condition) =>
    "owner_id" in condition ? String(property.owner_id) === String(condition.owner_id) : property.member_ids.some((id) => String(id) === String(condition.member_ids))))));
  t.mock.method(Property.prototype, "save", async function () { await this.validate(); properties.push(this); return this; });
  t.mock.method(Property, "updateOne", async (filter, update) => {
    const property = properties.find((record) => String(record._id) === String(filter._id));
    if (update.$addToSet) property.member_ids.addToSet(update.$addToSet.member_ids);
    if (update.$pull) property.member_ids.pull(update.$pull.member_ids);
    return { modifiedCount: 1 };
  });
  t.mock.method(RoomType, "find", () => query([]));
  t.mock.method(AuditLog, "create", async (values) => values);
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (work) => work(), endSession: async () => {} }));
  let guestQuery;
  t.mock.method(Guest, "findOne", (filter) => { guestQuery = filter; return query(null); });

  const { app } = require("../app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (user, path, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}` } : {}), ...options.headers }
  });
  assert.equal((await request(null, "/properties")).status, 401);
  const created = await request(owner, "/properties", { method: "POST", body: JSON.stringify({
    property_id: "hotel-test", owner_id: outsider._id,
    info: { hotel_name: "Test Hotel", address: "Test Street", country_code: "LK", email: "hotel@example.test" }
  }) });
  assert.equal(created.status, 201, await created.clone().text());
  const payload = await created.json();
  assert.equal(String(payload.property.owner_id), String(owner._id), "owner cannot be spoofed");
  assert.equal(payload.property.statistics.physical_room_count, 0);
  assert.equal((await (await request(owner, "/properties")).json()).properties.length, 1);
  assert.equal((await (await request(member, "/properties")).json()).properties.length, 0);
  properties.push(new Property({ property_id: "demo", info: {
    hotel_name: "Demo Hotel", address: "Demo Street", country_code: "LK", email: "demo@example.test"
  } }));
  const demoHeaders = { "x-demo-workspace": "1" };
  assert.equal((await request(null, "/properties/demo", { headers: demoHeaders })).status, 200,
    "demo can read its MongoDB-backed property");
  assert.equal((await request(null, "/rooms?property_id=demo", { headers: demoHeaders })).status, 200,
    "demo can read its room catalog");
  assert.equal((await request(null, "/properties/hotel-test", { headers: demoHeaders })).status, 403,
    "demo cannot read another hotel");
  assert.equal((await request(null, "/properties/demo/access", { headers: demoHeaders })).status, 403,
    "demo cannot read access details");
  assert.equal((await request(null, "/properties/demo", { headers: { ...demoHeaders, "x-property-id": "hotel-test" } })).status, 400,
    "conflicting demo property IDs are rejected");
  assert.equal((await request(null, "/properties/demo/info", {
    method: "PUT", headers: demoHeaders, body: JSON.stringify({ hotel_name: "Changed" })
  })).status, 403, "demo cannot write hotel records");
  assert.equal((await request(null, "/properties/demo")).status, 401,
    "demo reads require the explicit preview header");
  assert.equal((await request(outsider, "/properties/hotel-test")).status, 403);
  assert.equal((await request(outsider, "/rooms?property_id=hotel-test")).status, 403);
  assert.equal((await request(owner, "/properties/hotel-test", { headers: { "x-property-id": "different-hotel" } })).status, 400);
  assert.equal((await request(owner, "/properties/hotel-test/access", { method: "POST", body: JSON.stringify({ email: member.email }) })).status, 201);
  assert.equal((await request(member, "/properties/hotel-test")).status, 200);
  assert.equal((await request(member, "/properties/hotel-test/access", { method: "POST", body: JSON.stringify({ email: outsider.email }) })).status, 403);
  await request(owner, "/guests/findbymail/guest@example.test?property_id=hotel-test");
  assert.equal(guestQuery.property_id, "hotel-test", "email lookup must stay inside the selected hotel");
  assert.equal((await request(owner, `/properties/hotel-test/access/${member._id}`, { method: "DELETE" })).status, 200);
  assert.equal((await request(member, "/properties/hotel-test")).status, 403);
  assert.equal((await request(owner, `/properties/hotel-test/access/${owner._id}`, { method: "DELETE" })).status, 400);
  assert.equal((await request(owner, "/rooms")).status, 400, "unscoped operational requests must fail");
  await request(owner, `/guests/${new mongoose.Types.ObjectId()}?property_id=hotel-test`);
  assert.equal(guestQuery.property_id, "hotel-test", "record-ID lookups must also be property scoped");
  let registeredRole;
  t.mock.method(User.prototype, "save", async function () { await this.validate(); registeredRole = this.role; users.push(this); return this; });
  t.mock.method(Session, "create", async (values) => values);
  const registered = await request(null, "/auth/register", { method: "POST", body: JSON.stringify({
    name: "New account", email: "new@example.test", password: "test-password-123", role: "admin", emp_no: "02", mobile: "0771234567"
  }) });
  assert.equal(registered.status, 201);
  assert.equal(registeredRole, "user", "public registration cannot grant access to legacy hotels");
  const signedIn = await request(null, "/auth/login", { method: "POST", body: JSON.stringify({
    email: "new@example.test", password: "test-password-123"
  }) });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  const tokens = await signedIn.json();
  assert.equal(jwt.verify(tokens.token, process.env.JWT_SECRET).id, String(users.at(-1)._id));
  assert.equal(jwt.verify(tokens.refreshToken, process.env.JWT_SECRET_REFRESH).id, String(users.at(-1)._id));
});
