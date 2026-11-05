// Disposable local acceptance check. Never targets an existing hotel/account.
require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../db_models/user.model"), Property = require("../db_models/property.model"), RoomType = require("../db_models/rooms.model");
const { HousekeepingTask: Task, HousekeepingActivity: Activity, HousekeepingAttendant: Attendant } = require("../db_models/housecleaning.model");
const State = require("../db_models/notification-read-state.model"), Audit = require("../db_models/booking-log.model"), Guard = require("../db_models/inventory-guard.model");
const propertyId = `notification-smoke-${crypto.randomBytes(6).toString("hex")}`;
const userIds = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
let server, checks = 0;
async function main() {
  await mongoose.connect(process.env.mongoURI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const [owner, admin, a, b] = await User.create(userIds.map((_id, index) => ({ _id, name: `Notify Smoke ${index}`, email: `${propertyId}-${index}@example.test`, password: "disposable-fixture-no-login", mobile: "0771234567" })));
  const attendants = await Attendant.create([a, b].map((user, index) => ({ property_id: propertyId, employee_number: `SM-${index}`, name: user.name, status: "active" })));
  await Property.create({ property_id: propertyId, owner_id: owner._id, member_ids: [admin._id, a._id, b._id], administrator_ids: [admin._id],
    staff_roles: [{ user_id: a._id, role: "housekeeping", attendant_id: attendants[0]._id }, { user_id: b._id, role: "housekeeping", attendant_id: attendants[1]._id }],
    info: { hotel_name: propertyId, address: "Disposable fixture", email: "fixture@example.test", country_code: "LK" } });
  const roomType = await RoomType.create({ property_id: propertyId, name: "Smoke Standard", active: true, maximum_adults: 2, maximum_children: 0, base_rate: 1000, currency: "LKR",
    physical_rooms: ["N101", "N102", "N103"].map(room_number => ({ room_number, active: true, operational_status: "available", housekeeping_status: "dirty" })) });
  const { app } = require("../app"); server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const call = (user, path, method = "GET", body) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
    headers: { Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: "5m" })}`, "Content-Type": "application/json", "x-user-id": String(owner._id) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const expect = async (response, status) => { assert.equal(response.status, status, await response.clone().text()); checks++; return response.json(); };
  const feed = user => call(user, `/notifications?property_id=${propertyId}&limit=100&role=owner&attendant_id=${attendants[1]._id}`);
  const roomPath = index => `/housekeeping/rooms/${roomType.physical_rooms[index]._id}`;
  await expect(await call(owner, `${roomPath(0)}/request`, "POST", { property_id: propertyId, notes: "Disposable clean request" }), 201);
  await expect(await call(admin, `${roomPath(1)}/assign`, "POST", { property_id: propertyId, attendant_id: attendants[0]._id }), 200);
  await expect(await call(owner, `${roomPath(2)}/assign`, "POST", { property_id: propertyId, attendant_id: attendants[1]._id }), 200);
  const ownerFeed = await expect(await feed(owner), 200), adminFeed = await expect(await feed(admin), 200);
  assert.equal(ownerFeed.notifications.length, 3); assert.equal(adminFeed.notifications.length, 3); checks++;
  const aFeed = await expect(await feed(a), 200), bFeed = await expect(await feed(b), 200);
  assert.equal(aFeed.notifications.length, 2); assert.equal(bFeed.notifications.length, 2); checks++;
  const bAssignment = bFeed.notifications.find(item => item.type === "housekeeping_assignment");
  assert.ok(aFeed.notifications.every(item => item.id !== bAssignment.id)); checks++;
  await expect(await call(a, `/notifications/${encodeURIComponent(bAssignment.id)}/read`, "PATCH", { property_id: propertyId }), 404);
  await expect(await call(a, "/notifications/read-all", "POST", { property_id: propertyId }), 200);
  assert.equal((await expect(await feed(a), 200)).unread_count, 0); checks++;
  assert.equal((await expect(await feed(b), 200)).unread_count, 2); checks++;
  const state = await State.findOne({ property_id: propertyId, user_id: String(a._id) });
  assert.equal(state.read_through_at, undefined); assert.equal(state.read_notification_ids.length, 2); checks++;
  await expect(await call(b, `${roomPath(0)}/claim`, "POST", { property_id: propertyId }), 200);
  const claimedOwner = await expect(await feed(owner), 200), claimedA = await expect(await feed(a), 200), claimedB = await expect(await feed(b), 200);
  assert.equal(claimedOwner.notifications.length, 4); assert.ok(claimedOwner.notifications.some(item => item.title.includes("claimed"))); checks++;
  assert.equal(claimedA.notifications.length, 1); assert.equal(claimedB.notifications.length, 2); checks++;
  const requestActivity = await Activity.findOne({ property_id: propertyId, action: "requested" });
  await expect(await call(a, `/notifications/housekeeping_request:${requestActivity._id}/read`, "PATCH", { property_id: propertyId }), 404);
  await Attendant.updateOne({ _id: attendants[0]._id }, { $set: { status: "inactive" } });
  await expect(await feed(a), 403);
  console.log(`PASS: ${checks} database-backed housekeeping notification checks: real request/assign/claim events, Owner/Admin and attendant audiences, read isolation, claimed-request removal and inactive access.`);
}
main().catch(failure => { console.error(`FAIL: housekeeping notification acceptance (${failure.name}); inspect fixture assertions. No connection credentials are printed.`); process.exitCode = 1; }).finally(async () => {
  try {
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState === 1) {
      for (const model of [State, Audit, Activity, Task, Attendant, RoomType, Property]) await model.deleteMany({ property_id: propertyId });
      await Guard.deleteMany({ _id: propertyId }); await User.deleteMany({ _id: { $in: userIds } });
      for (const model of [State, Audit, Activity, Task, Attendant, RoomType, Property]) assert.equal(await model.countDocuments({ property_id: propertyId }), 0);
      assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0); assert.equal(await Guard.countDocuments({ _id: propertyId }), 0);
      console.log("Disposable notification accounts, hotel, rooms, tasks, activities, read states, audits and guard removed; cleanup verified.");
    }
  } catch { console.error(`Cleanup needs inspection for fixture ${propertyId}.`); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
});
