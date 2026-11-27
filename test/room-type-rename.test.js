const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../db_models/user.model");
const Property = require("../db_models/property.model");
const RoomType = require("../db_models/rooms.model");
const InventoryGuard = require("../db_models/inventory-guard.model");

test("room-type rename API checks property roles and preserves stable identities", async (t) => {
  process.env.JWT_SECRET = "isolated-room-rename-tests";
  const users = ["owner", "administrator", "member", "front_desk", "housekeeping", "finance", "outsider"].map(name => ({
    _id: new mongoose.Types.ObjectId(), name, email: `${name}@example.test`, role: "user"
  }));
  const [owner, administrator, member, frontDesk, housekeeping, finance] = users;
  const property = new Property({ property_id: "rename-fixture", owner_id: owner._id,
    member_ids: [administrator, member, frontDesk, housekeeping, finance].map(user => user._id),
    administrator_ids: [administrator._id], staff_roles: [frontDesk, housekeeping, finance].map(user => ({ user_id: user._id, role: user.name })),
    info: { hotel_name: "Rename Hotel", address: "Test Road", email: "hotel@example.test", country_code: "LK" } });
  const original = new RoomType({ property_id: property.property_id, name: "Standard", base_rate: 6500,
    physical_rooms: [{ room_number: "101", operational_status: "occupied" }, { room_number: "102" }] });
  await original.validate();
  let stored = original.toObject();
  const query = value => ({ select() { return this; }, session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  t.mock.method(User, "findById", id => query(users.find(user => String(user._id) === String(id))));
  t.mock.method(Property, "findOne", filter => query(filter.property_id === property.property_id ? property : null));
  t.mock.method(RoomType, "findOne", filter => query(String(filter._id) === String(stored._id) && filter.property_id === stored.property_id ? new RoomType(stored) : null));
  t.mock.method(RoomType.prototype, "save", async function ({ session }) {
    assert.ok(session.inTransaction()); await this.validate(); stored = this.toObject(); return this;
  });
  t.mock.method(InventoryGuard, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(mongoose, "startSession", async () => ({ inTransaction: () => true,
    withTransaction: async work => work(), endSession: async () => {} }));
  const { app } = require("../app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (actor, name, propertyId = property.property_id) => fetch(`http://127.0.0.1:${server.address().port}/api/rooms/${original._id}?property_id=${propertyId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET)}` },
    body: JSON.stringify({ name })
  });
  for (const actor of users.slice(2)) {
    const response = await request(actor, "Unauthorized rename");
    assert.equal(response.status, 403, actor.name);
    assert.equal(stored.name, "Standard");
  }
  assert.equal((await request(owner, "Garden Standard", "another-property")).status, 403);
  for (const actor of [owner, administrator]) {
    const name = actor === owner ? "Garden Standard" : "Garden View";
    const response = await request(actor, name);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const saved = (await response.json()).room_type;
    assert.equal(saved.name, name);
    assert.equal(saved._id, String(original._id));
    assert.equal(saved.base_rate, 6500);
    assert.deepEqual(saved.physical_rooms.map(room => room._id), original.physical_rooms.map(room => String(room._id)));
    assert.equal(saved.physical_rooms[0].operational_status, "occupied");
    assert.ok(saved.physical_rooms.every(room => room.room_type === name));
  }
  assert.equal((await request(owner, " ")).status, 400);
  assert.equal(stored.name, "Garden View");
});
