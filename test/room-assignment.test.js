const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const mongod = process.env.MONGOD_BINARY || "C:/Program Files/MongoDB/Server/8.0/bin/mongod.exe";

// A disposable, loopback-only replica set: never reads the application's Mongo
// connection string or mutates the developer's property records.
test("room unassignment and reassignment preserve identity, inventory and permissions", {
  skip: !fs.existsSync(mongod) && "Set MONGOD_BINARY to run the MongoDB integration checks", timeout: 90000
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dms-room-assignment-"));
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening"); const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const processMongo = spawn(mongod, ["--replSet", "roomAssignment", "--dbpath", directory,
    "--bind_ip", "127.0.0.1", "--port", String(port), "--logpath", path.join(directory, "mongo.log")], { stdio: "ignore", windowsHide: true });
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    if (processMongo.exitCode === null && processMongo.signalCode === null) {
      const ended = once(processMongo, "exit"); processMongo.kill(); await ended;
    }
    if (path.dirname(directory) === fs.realpathSync(os.tmpdir()) && path.basename(directory).startsWith("dms-room-assignment-")) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const uri = `mongodb://127.0.0.1:${port}`;
  const client = new mongoose.mongo.MongoClient(`${uri}/?directConnection=true`, { serverSelectionTimeoutMS: 300 });
  try {
    for (let i = 0; ; i++) {
      try { await client.connect(); break; } catch (error) { if (i > 60) throw error; await delay(100); }
    }
    await client.db("admin").command({ replSetInitiate: { _id: "roomAssignment", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  } finally { await client.close(); }
  process.env.JWT_SECRET = "isolated-room-assignment-tests";
  const { app } = require("../app");
  const User = require("../db_models/user.model");
  const Property = require("../db_models/property.model");
  const RoomType = require("../db_models/rooms.model");
  const UnassignedRoom = require("../db_models/unassigned-room.model");
  const Reservation = require("../db_models/booking.model");
  const { HousekeepingTask, HousekeepingActivity } = require("../db_models/housecleaning.model");
  const { RatePlan } = require("../db_models/rates.model");
  const IbeSettings = require("../db_models/ibe-settings.model");
  const { searchPublicRooms } = require("../services/public-ibe.service");
  await mongoose.connect(`${uri}/room_assignment?replicaSet=roomAssignment`, { serverSelectionTimeoutMS: 15000 });
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  const roles = ["owner", "administrator", "member", "front_desk", "housekeeping", "finance", "outsider"];
  const users = await User.create(roles.map(name => ({ name, email: `${name}@example.test`, mobile: "0711112222", password: "fixture-password" })));
  const propertyId = "room-assignment-fixture";
  await Property.create({ property_id: propertyId, business_date: "2026-11-27", owner_id: users[0]._id,
    member_ids: users.slice(1, 6).map(user => user._id), administrator_ids: [users[1]._id],
    staff_roles: users.slice(3, 6).map((user, index) => ({ user_id: user._id, role: roles[index + 3], ...(index === 1 ? { attendant_id: new mongoose.Types.ObjectId() } : {}) })),
    info: { hotel_name: "Fixture", address: "Test Road", country_code: "LK", email: "hotel@example.test" } });
  const standard = await RoomType.create({ property_id: propertyId, name: "Standard", base_rate: 6500,
    physical_rooms: [{ room_number: "101", floor: "2", housekeeping_status: "inspected", notes: "Sea view" }, { room_number: "102" }, { room_number: "103" }] });
  const deluxe = await RoomType.create({ property_id: propertyId, name: "Deluxe", base_rate: 9500 });
  const room = standard.physical_rooms[0].toObject();
  const plan = await RatePlan.create({ property_id: propertyId, name: "Flexible", code: "FLEX", valid_from: "2000-01-01", valid_to: "2099-12-31", cancellation_policy: "Contact the hotel.",
    room_type_rates: [{ room_type_id: standard._id, amount: 6500 }, { room_type_id: deluxe._id, amount: 9500 }] });
  await IbeSettings.create({ _id: propertyId, version: 1, settings: { publicRatePlanId: String(plan._id), config: { ibeActive: true, payAtProperty: true } } });
  const reservation = (no, overrides = {}) => ({ property_id: propertyId, reservation_no: no, status: "confirmed", check_in: "2026-12-01", check_out: "2026-12-03",
    booking_source: "Direct", currency: "LKR", booker: { name: "Test Guest", email: "guest@example.test", phone: "0711112222", country: "Sri Lanka" },
    rooms: [{ room_type_id: standard._id, room_type_name: "Standard", physical_room_id: room._id, room_number: room.room_number,
      adults: 1, children: 0, original_nightly_rate: 6500, effective_nightly_rate: 6500 }], ...overrides });
  const old = await Reservation.create(reservation("PAST", { status: "checked_out", check_in: "2026-11-01", check_out: "2026-11-02" }));
  await mongoose.connection.db.collection("invoices").insertOne({ property_id: propertyId, reservation_id: old._id,
    invoice_no: "HISTORY", lines: [{ description: "Standard · 101", amount: 6500 }], total: 6500 });
  const history = await HousekeepingActivity.create({ property_id: propertyId, physical_room_id: room._id, room_type_id: standard._id,
    room_number: "101", room_type_name: "Standard", action: "inspection_completed", notes: "All checked" });
  const snapshots = async () => JSON.stringify(await Promise.all([
    Reservation.findById(old._id).lean(), RatePlan.findById(plan._id).lean(), HousekeepingActivity.findById(history._id).lean(),
    mongoose.connection.db.collection("invoices").findOne({ invoice_no: "HISTORY" })
  ]));
  const before = await snapshots();
  server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  async function request(route, method = "GET", body, actor = users[0], property = propertyId) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api${route}?property_id=${property}`, { method,
      headers: { Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET)}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, body: await result.json() };
  }
  const assignment = id => `/rooms/physical-rooms/${id}/assignment`;
  await t.test("unassign keeps the room details, identity and history, reducing only its type inventory", async () => {
    const result = await request(`/rooms/${standard._id}`, "PATCH", { room_numbers: ["102", "103"] });
    assert.equal(result.status, 200, JSON.stringify(result));
    const parked = await UnassignedRoom.findById(room._id);
    for (const field of ["room_number", "floor", "housekeeping_status", "operational_status", "notes"]) assert.equal(parked[field], room[field]);
    assert.equal(+parked.created_at, +room.created_at);
    const catalog = await request("/rooms");
    assert.equal(catalog.body.unassigned_rooms[0].room_type_id, null);
    assert.equal(catalog.body.unassigned_rooms[0]._id, String(room._id));
    assert.equal(catalog.body.room_types.flatMap(type => type.physical_rooms).length, 2);
    assert.equal((await request("/rooms/physical-rooms")).body.count, 3);
    const checkIn = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const checkOut = new Date(Date.now() + 11 * 86400000).toISOString().slice(0, 10);
    const publicOffers = await searchPublicRooms(propertyId, { checkIn, checkOut, adults: 1, children: 0 });
    assert.equal(publicOffers.offers.length, 1);
    assert.equal(publicOffers.offers[0].roomTypeId, String(standard._id));
    assert.equal(await snapshots(), before);
  });
  await t.test("every physical-room creation path rejects an unassigned room's number", async () => {
    assert.equal((await request(`/rooms/${deluxe._id}/physical-rooms`, "POST", { room_number: "101" })).status, 409);
    assert.equal((await request("/rooms", "POST", { property_id: propertyId, name: "Duplicate", base_rate: 1, physical_rooms: [{ room_number: "101" }] })).status, 409);
    assert.equal((await request(`/rooms/${standard._id}/physical-rooms/${standard.physical_rooms[1]._id}`, "PATCH", { room_number: "101" })).status, 409);
  });
  await t.test("only Owner/Admin may unassign, reassign or delete; another property cannot be targeted", async () => {
    for (const actor of users.slice(2)) {
      assert.equal((await request(assignment(room._id), "PATCH", { room_type_id: String(deluxe._id) }, actor)).status, 403, actor.name);
      assert.equal((await request(`/rooms/unassigned-physical-rooms/${room._id}`, "DELETE", undefined, actor)).status, 403, actor.name);
      assert.equal((await request(`/rooms/${standard._id}/physical-rooms/${standard.physical_rooms[1]._id}`, "DELETE", undefined, actor)).status, 403, actor.name);
    }
    assert.equal((await request(assignment(room._id), "PATCH", { room_type_id: String(deluxe._id) }, users[0], "another-property")).status, 403);
    assert.equal((await request("/rooms", "GET", undefined, users[3])).body.unassigned_rooms.length, 0);
  });
  await t.test("assigning an existing room keeps its ID and old snapshots; history still blocks deletion", async () => {
    assert.equal((await request(`/rooms/unassigned-physical-rooms/${room._id}`, "DELETE")).status, 409);
    const result = await request(assignment(room._id), "PATCH", { room_type_id: String(deluxe._id) }, users[1]);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.physical_room._id, String(room._id));
    assert.equal(result.body.physical_room.housekeeping_status, "inspected");
    assert.equal(await UnassignedRoom.countDocuments(), 0);
    assert.equal(await snapshots(), before);
    assert.equal((await request(`/rooms/${deluxe._id}/physical-rooms/${room._id}`, "DELETE")).status, 409);
  });
  await t.test("direct transfers between types also retain the ID", async () => {
    const result = await request(assignment(room._id), "PATCH", { room_type_id: String(standard._id) });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.physical_room._id, String(room._id));
  });
  await t.test("occupied rooms and future assignments prevent unassignment", async () => {
    const collection = mongoose.connection.db.collection("room_types");
    await collection.updateOne({ _id: standard._id, "physical_rooms._id": room._id }, { $set: { "physical_rooms.$.operational_status": "occupied" } });
    const occupied = await request(assignment(room._id), "PATCH", { room_type_id: null });
    assert.equal(occupied.status, 409, JSON.stringify(occupied));
    await collection.updateOne({ _id: standard._id, "physical_rooms._id": room._id }, { $set: { "physical_rooms.$.operational_status": "available" } });
    const future = await Reservation.create(reservation("FUTURE"));
    assert.equal((await request(assignment(room._id), "PATCH", { room_type_id: null })).status, 409);
    await Reservation.deleteOne({ _id: future._id });
  });
  await t.test("failed batch changes roll back details and all unassignments when capacity is needed", async () => {
    const capacity = await Reservation.create(reservation("CAPACITY", { rooms: Array.from({ length: 3 }, () => ({ room_type_id: standard._id, room_type_name: "Standard", adults: 1, children: 0, original_nightly_rate: 6500, effective_nightly_rate: 6500 })) }));
    const result = await request(`/rooms/${standard._id}`, "PATCH", { description: "Must roll back", room_numbers: ["102"] });
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.match(result.body.message, /3 are needed/);
    const unchanged = await RoomType.findById(standard._id);
    assert.equal(unchanged.description, ""); assert.equal(unchanged.physical_rooms.length, 3);
    assert.equal(await UnassignedRoom.countDocuments(), 0);
    await Reservation.deleteOne({ _id: capacity._id });
  });
  await t.test("open housekeeping work blocks transfers; completed history remains intact", async () => {
    const task = await HousekeepingTask.create({ property_id: propertyId, physical_room_id: room._id, room_type_id: standard._id, room_number: "101", room_type_name: "Standard", status: "assigned" });
    assert.equal((await request(assignment(room._id), "PATCH", { room_type_id: null })).status, 409);
    await HousekeepingTask.deleteOne({ _id: task._id });
    assert.equal(await snapshots(), before);
  });
  await t.test("room-type editor can claim unassigned rooms and delete a never-used physical room separately", async () => {
    const id = standard.physical_rooms[2]._id;
    assert.equal((await request(assignment(id), "PATCH", { room_type_id: null })).status, 200);
    const result = await request(`/rooms/${deluxe._id}`, "PATCH", { room_numbers: ["103"] });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.room_type.physical_rooms[0]._id, String(id));
    assert.equal((await request(`/rooms/${deluxe._id}/physical-rooms/${id}`, "DELETE")).status, 200);
    assert.equal(await UnassignedRoom.countDocuments(), 0);
    assert.equal(await snapshots(), before);
  });
  await t.test("stale room-type saves are rejected without losing rooms", async () => {
    const type = (await request(`/rooms/${standard._id}`)).body.room_type;
    assert.equal(typeof type.version, "number");
    assert.equal((await request(`/rooms/${standard._id}`, "PATCH", { expected_version: type.version, description: "Concurrent update" })).status, 200);
    const stale = await request(`/rooms/${standard._id}`, "PATCH", { expected_version: type.version, room_numbers: [] });
    assert.equal(stale.status, 409, JSON.stringify(stale));
    assert.equal((await RoomType.findById(standard._id)).physical_rooms.length, 2);
  });
  await t.test("two concurrent assignments cannot claim the same unassigned room", async () => {
    const created = await request(`/rooms/${standard._id}/physical-rooms`, "POST", { room_number: "201" });
    const id = created.body.physical_room._id;
    assert.equal((await request(assignment(id), "PATCH", { room_type_id: null })).status, 200);
    const results = await Promise.all([standard, deluxe].map(type => request(assignment(id), "PATCH", { room_type_id: String(type._id), expected_room_type_id: null })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(await RoomType.countDocuments({ property_id: propertyId, "physical_rooms._id": id }), 1);
    assert.equal(await UnassignedRoom.countDocuments({ _id: id }), 0);
    assert.equal(await snapshots(), before);
  });
});
