const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const mongoose = require("mongoose");
const WebsiteKey = require("../db_models/ibe-website-key.model");
const Property = require("../db_models/property.model");
const Settings = require("../db_models/ibe-settings.model");
const transactions = require("../services/inventory-transaction.service");
const audit = require("../services/booking-audit.service");

function query(value) {
  return { session() { return this; }, select() { return this; }, lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}

test("website keys authenticate the property and can only be managed by its Owner/Admin", async (t) => {
  const owner = { _id: new mongoose.Types.ObjectId() };
  const admin = { _id: new mongoose.Types.ObjectId() };
  const other = { _id: new mongoose.Types.ObjectId() };
  const property = { _id: new mongoose.Types.ObjectId(), property_id: "hotel-one", status: "active",
    owner_id: owner._id, member_ids: [admin._id], administrator_ids: [admin._id] };
  let record = null;
  let logs = [];
  t.mock.method(Property, "findOne", () => query(property));
  t.mock.method(Settings, "findById", () => query({ settings: { websiteOrigin: "https://hotel.example" } }));
  t.mock.method(WebsiteKey, "findById", (id) => query(id === "hotel-one" ? record : null));
  t.mock.method(WebsiteKey, "findByIdAndUpdate", (id, change) => {
    record = { ...record, _id: id, ...change.$set };
    return query(record);
  });
  t.mock.method(transactions, "withInventoryTransaction", async (id, work) => {
    assert.equal(id, "hotel-one"); return work(null);
  });
  t.mock.method(audit, "writeAuditLog", async (payload) => logs.push(payload));
  const path = require.resolve("../services/ibe-website-key.service");
  delete require.cache[path];
  const service = require(path);
  t.after(() => delete require.cache[path]);
  const req = (user = owner, expectedKeyId = record?.key_id || null) => ({
    authorizedProperty: property, workspaceUser: user,
    body: { expectedKeyId, name: "Hotel website", websiteOrigin: "https://hotel.example" },
    get: (header) => ({ "x-user-id": String(user._id), "x-user-name": "Owner", "x-user-email": "owner@example.test" })[header]
  });
  const call = (key, propertyId = "hotel-one") => ({ params: { propertyId }, get: () => key });
  let first, replacement;
  await t.test("generates a strong one-time secret and persists only its hash", async () => {
    first = await service.changeWebsiteKey(req());
    assert.match(first.secret, /^ibe_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(record.key_hash, createHash("sha256").update(first.secret).digest("hex"));
    await new WebsiteKey(record).validate();
    assert.equal(JSON.stringify(record).includes(first.secret), false);
    const metadata = await service.getWebsiteKey("hotel-one");
    assert.equal(metadata.key.active, true);
    assert.equal(Object.hasOwn(metadata.key, "key_hash"), false);
    assert.equal(Object.hasOwn(metadata, "secret"), false);
    assert.equal(JSON.stringify(logs).includes(first.secret), false);
  });
  await t.test("accepts the matching key and assigns trusted integration metadata", async () => {
    const request = call(first.secret);
    await service.authenticateWebsiteKey(request);
    assert.deepEqual(request.ibeIntegration, { id: record.key_id, name: "Hotel website", website_origin: "https://hotel.example" });
  });
  await t.test("rejects missing, malformed, forged and other-property keys", async () => {
    for (const value of [undefined, "", "bad", "x".repeat(1000), first.secret.slice(0, -1) + (first.secret.endsWith("a") ? "b" : "a")]) {
      await assert.rejects(service.authenticateWebsiteKey(call(value)), { statusCode: 401 });
    }
    await assert.rejects(service.authenticateWebsiteKey(call(first.secret, "hotel-two")), { statusCode: 401 });
    await assert.rejects(service.authenticateWebsiteKey(call(first.secret, "demo")), { statusCode: 401 });
    await assert.rejects(service.authenticateWebsiteKey(call(first.secret, { $ne: "" })), { statusCode: 401 });
  });
  await t.test("prevents non-administrators and stale management requests", async () => {
    await assert.rejects(service.changeWebsiteKey(req(other)), { statusCode: 403 });
    await assert.rejects(service.changeWebsiteKey(req(owner, null)), { statusCode: 409 });
    await assert.rejects(service.changeWebsiteKey({ ...req(), body: { ...req().body, websiteOrigin: "https://unsaved.example" } }), { statusCode: 400 });
  });
  await t.test("Administrator replacement immediately rejects the previous key", async () => {
    replacement = await service.changeWebsiteKey(req(admin));
    assert.notEqual(first.secret, replacement.secret);
    await assert.rejects(service.authenticateWebsiteKey(call(first.secret)), { statusCode: 401 });
    await service.authenticateWebsiteKey(call(replacement.secret));
    assert.equal(logs.at(-1).action, "ibe_website_key_replaced");
  });
  await t.test("revocation disables the key and never returns its secret", async () => {
    const result = await service.changeWebsiteKey(req(), true);
    assert.equal(result.key.active, false);
    assert.equal(Object.hasOwn(result, "secret"), false);
    await assert.rejects(service.authenticateWebsiteKey(call(replacement.secret)), { statusCode: 401 });
    assert.equal(logs.at(-1).action, "ibe_website_key_revoked");
  });
  await t.test("all three HTTP endpoints enforce the key before returning data or creating bookings", async () => {
    const active = await service.changeWebsiteKey(req());
    const publicService = require("../services/public-ibe.service");
    const activityService = require("../services/ibe-api-activity.service");
    const calls = [];
    t.mock.method(publicService, "publicPropertyDetails", async () => { calls.push("details"); return { name: "Hotel" }; });
    t.mock.method(publicService, "searchPublicRooms", async () => { calls.push("search"); return { offers: [] }; });
    t.mock.method(publicService, "createPublicBooking", async () => { calls.push("book"); return { created: true, booking: { reference: "RES-TEST" } }; });
    t.mock.method(activityService, "recordIbeActivity", async () => {});
    const routerPath = require.resolve("../routes/public-ibe");
    delete require.cache[routerPath];
    const express = require("express");
    const app = express(); app.use("/api/public/ibe", require(routerPath));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const url = "http://127.0.0.1:" + server.address().port + "/api/public/ibe/hotel-one";
      for (const [method, suffix] of [["GET", ""], ["GET", "/availability"], ["POST", "/bookings"]]) {
        assert.equal((await fetch(url + suffix, { method })).status, 401);
        assert.equal((await fetch(url + suffix, { method, headers: { Origin: "https://hotel.example" } })).status, 401);
        assert.equal((await fetch(url + suffix + "?api_key=" + active.secret, { method })).status, 401);
      }
      assert.deepEqual(calls, []);
      for (const [method, suffix] of [["GET", ""], ["GET", "/availability"], ["POST", "/bookings"]]) {
        assert.equal((await fetch(url + suffix, { method, headers: { "X-IBE-API-Key": active.secret } })).status, method === "POST" ? 201 : 200);
      }
      assert.deepEqual(calls, ["details", "search", "book"]);
    } finally { await new Promise((resolve) => server.close(resolve)); delete require.cache[routerPath]; }
  });
});
