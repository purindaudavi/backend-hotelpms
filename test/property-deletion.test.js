const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../db_models/user.model");
const Property = require("../db_models/property.model");
const Request = require("../db_models/property-deletion-request.model");
const Guard = require("../db_models/inventory-guard.model");
const Audit = require("../db_models/booking-log.model");
const { withInventoryTransaction } = require("../services/inventory-transaction.service");

function matches(record, filter) {
  return Object.entries(filter).every(([field, wanted]) => {
    if (field === "$or") return wanted.some(item => matches(record, item));
    const value = field.split(".").reduce((item, key) => item?.[key], record);
    if (wanted && typeof wanted === "object" && !(wanted instanceof mongoose.Types.ObjectId)) {
      if (wanted.$in) return wanted.$in.some(item => String(item) === String(value));
      if (wanted.$gte) return new Date(value) >= wanted.$gte;
    }
    return String(value) === String(wanted);
  });
}
function query(value) {
  return {
    session() { return this; }, select() { return this; }, sort() { return this; },
    limit(count) { if (Array.isArray(value)) value = value.slice(0, count); return this; },
    lean() { value = Array.isArray(value) ? value.map(item => item.toObject ? item.toObject() : item) : value?.toObject ? value.toObject() : value; return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}
async function fixture(t) {
  process.env.JWT_SECRET = "isolated-property-deletion-secret";
  const make = (name, extra = {}) => ({ _id: new mongoose.Types.ObjectId(), name, email: `${name}@example.test`, mobile: "0771234567", role: "user", ...extra });
  const platform = make("platform", { platform_owner: true }), owner = make("owner"), admin = make("administrator"), staff = make("housekeeper"), outsider = make("outsider"), legacy = make("legacy", { role: "admin" });
  const users = [platform, owner, admin, staff, outsider, legacy];
  const properties = ["one", "two", "three", "four"].map(name => new Property({ property_id: `deletion-${name}`, owner_id: owner._id, member_ids: [admin._id, staff._id], administrator_ids: [admin._id], info: { hotel_name: `Hotel ${name}`, address: "Private address", country_code: "LK", email: "hotel@example.test" } }));
  properties.forEach(record => record.version = 0);
  const requests = [], audits = [], guards = new Map(); let queue = Promise.resolve();
  t.mock.method(mongoose, "startSession", async () => ({ async withTransaction(work) { const before = queue; let release; queue = new Promise(resolve => release = resolve); await before; try { return await work(); } finally { release(); } }, async endSession() {} }));
  t.mock.method(Guard, "updateOne", async (filter, update) => {
    if (update.$setOnInsert && !guards.has(filter._id)) guards.set(filter._id, false);
    if (filter.property_archived && guards.get(filter._id)) return { matchedCount: 0 };
    if (update.$set) guards.set(filter._id, update.$set.property_archived);
    return { matchedCount: 1 };
  });
  t.mock.method(User, "findById", id => query(users.find(user => String(user._id) === String(id)) || null));
  t.mock.method(Property, "findOne", filter => query(properties.find(record => matches(record, filter)) || null));
  t.mock.method(Property, "find", filter => query(properties.filter(record => matches(record, filter))));
  t.mock.method(Property.prototype, "save", async function () { await this.validate(); this.version++; return this; });
  t.mock.method(Request, "findOne", filter => query(requests.find(record => matches(record, filter)) || null));
  t.mock.method(Request, "findById", id => query(requests.find(record => String(record._id) === String(id)) || null));
  t.mock.method(Request, "find", filter => query(requests.filter(record => matches(record, filter))));
  t.mock.method(Request, "countDocuments", filter => query(requests.filter(record => matches(record, filter)).length));
  t.mock.method(Request, "create", async values => {
    const records = values.map(value => new Request({ ...value, version: 0, created_at: new Date() }));
    for (const record of records) { await record.validate(); requests.push(record); }
    return records;
  });
  t.mock.method(Request.prototype, "save", async function () { await this.validate(); this.version++; return this; });
  t.mock.method(Audit, "create", async values => { audits.push(...values); return values; });
  const { app } = require("../app"); const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (user, path, method = "GET", body) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
    headers: { "Content-Type": "application/json", "x-user-name": "Forged actor", "x-platform-owner": "true", ...(user ? { Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const input = property => ({ version: property.version, confirm_name: property.info.hotel_name, contact_phone: "+94 77 123 4567", reason: "Please archive this property after the platform review." });
  const submit = (user, property, extra = {}) => call(user, `/property-deletion/properties/${property.property_id}/requests`, "POST", { ...input(property), ...extra });
  const decide = (record, property, extra = {}) => call(platform, `/property-deletion/review/${record._id}/decision`, "POST", { version: record.version, property_version: property.version, confirm_name: property.info.hotel_name, decision: "approve", note: "Verified the request with the property contact.", ...extra });
  return { platform, owner, admin, staff, outsider, legacy, users, properties, requests, audits, guards, call, submit, decide };
}

test("property deletion requests verify Owner/Admin scope and platform approval, preserve identity and recheck fresh authority", async t => {
  const f = await fixture(t), { call, submit, decide, properties: [property], owner, admin, staff, outsider, legacy, platform, requests, audits, guards } = f;
  assert.equal((await call(null, "/property-deletion")).status, 401);
  for (const actor of [staff, outsider, legacy]) {
    assert.equal((await call(actor, `/property-deletion/properties/${property.property_id}`)).status, 403);
    assert.equal((await submit(actor, property, { role: "owner", platform_owner: true })).status, 403);
  }
  assert.equal((await submit(owner, property, { contact_phone: "invalid" })).status, 400);
  assert.equal((await submit(owner, property, { confirm_name: "Other hotel" })).status, 400);
  assert.equal((await submit(owner, property, { version: 99 })).status, 409);
  const response = await submit(admin, property, { status: "approved", requester_id: outsider._id, requested_by: { name: "Forged" }, property_id: "forged" });
  assert.equal(response.status, 201, await response.clone().text()); const request = (await response.json()).request;
  assert.equal(request.requester_id, String(admin._id)); assert.equal(request.requested_by.name, admin.name); assert.equal(request.status, "pending"); assert.equal(request.requester_role, "administrator"); assert.match(request.request_code, /^PDR-[A-F0-9]{24}$/);
  assert.equal(property.status, "active"); assert.equal((await submit(owner, property)).status, 409);
  const context = await (await call(owner, `/property-deletion/properties/${property.property_id}`)).json(); assert.equal(context.pending.request_code, request.request_code); assert.ok(!JSON.stringify(context).includes("Private address"));
  assert.equal((await (await call(outsider, "/property-deletion")).json()).requests.length, 0);
  assert.equal((await call(owner, `/property-deletion/requests/${request._id}/cancel`, "POST", { version: 0 })).status, 404);
  for (const actor of [owner, admin, staff, outsider, legacy]) {
    assert.equal((await call(actor, "/property-deletion/review")).status, 403);
    assert.equal((await call(actor, `/property-deletion/review/${request._id}/decision`, "POST", { decision: "approve", version: 0, note: "Fake platform review" })).status, 403);
  }
  const queue = await (await call(platform, "/property-deletion/review")).json(); assert.equal(queue.requests[0].request_code, request.request_code); assert.equal(queue.requests[0].current_property.version, 0);
  assert.equal((await decide(request, property, { property_version: undefined })).status, 400);
  assert.equal((await decide(request, property, { confirm_name: "Wrong name" })).status, 400);
  property.administrator_ids = [];
  assert.equal((await decide(request, property)).status, 409, "revoked administrator requests cannot authorize an archive");
  property.administrator_ids = [admin._id];
  const originalId = String(property._id), members = property.member_ids.map(String);
  property.info.hotel_name = "New hotel name"; property.version++;
  assert.equal((await decide(request, property, { property_version: 0 })).status, 409);
  assert.equal((await decide(request, property, { confirm_name: "Hotel one" })).status, 400);
  const approval = await decide(request, property, { note: "x".repeat(1000) }); assert.equal(approval.status, 200, await approval.clone().text());
  assert.equal(requests[0].status, "approved"); assert.equal(property.status, "inactive"); assert.equal(guards.get(property.property_id), true);
  assert.equal(String(property._id), originalId); assert.deepEqual(property.member_ids.map(String), members); assert.equal(property.property_id, "deletion-one");
  assert.equal((await call(owner, `/properties/${property.property_id}/my-access`)).status, 403);
  await assert.rejects(withInventoryTransaction(property.property_id, async () => assert.fail("archived write ran")), { statusCode: 503 });
  const history = await (await call(admin, "/property-deletion")).json(); assert.equal(history.requests[0].status, "approved");
  assert.equal((await decide(requests[0], property)).status, 409);
  const restored = await call(platform, `/platform/properties/${property.property_id}/restore`, "POST", { version: property.version, confirm_name: property.info.hotel_name, reason: "Restore approved archived property" }); assert.equal(restored.status, 200);
  assert.equal((await call(owner, `/properties/${property.property_id}/my-access`)).status, 200);
  assert.ok(audits.some(record => record.action === "property_deletion_requested" && record.actor.user_id === String(admin._id)));
  assert.ok(audits.some(record => record.action === "property_platform_archived" && record.actor.user_id === String(platform._id)));
  assert.ok(audits.some(record => record.action === "property_deletion_approved"));
});

test("deletion cancellation/review races serialize, rejection is harmless, ownership changes invalidate approval and repeated requests are bounded", async t => {
  const { call, submit, decide, owner, admin, outsider, properties, requests } = await fixture(t);
  const [one, two, three, four] = properties;
  let request = (await (await submit(owner, one)).json()).request;
  const race = await Promise.all([decide(request, one), call(owner, `/property-deletion/requests/${request._id}/cancel`, "POST", { version: 0 })]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  request = (await (await submit(owner, two)).json()).request;
  assert.equal((await decide(request, two, { decision: "reject", note: "" })).status, 400);
  assert.equal((await decide(request, two, { decision: "reject", note: "Please keep this property operational." })).status, 200);
  assert.equal(two.status, "active"); assert.equal(requests.find(record => String(record._id) === request._id).status, "rejected");
  request = (await (await submit(admin, three)).json()).request;
  three.owner_id = outsider._id;
  assert.equal((await decide(request, three)).status, 409);
  assert.equal((await decide(request, three, { decision: "reject" })).status, 200);
  assert.equal(three.status, "active");
  for (let index = 0; index < 5; index++) {
    request = (await (await submit(owner, four)).json()).request;
    assert.equal((await call(owner, `/property-deletion/requests/${request._id}/cancel`, "POST", { version: 0 })).status, 200);
  }
  assert.equal((await submit(owner, four)).status, 429);
});
