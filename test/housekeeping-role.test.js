const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Property = require("../db_models/property.model");
const User = require("../db_models/user.model");
const RoomType = require("../db_models/rooms.model");
const Guard = require("../db_models/inventory-guard.model");
const Audit = require("../db_models/booking-log.model");
const { HousekeepingAttendant, HousekeepingTask, HousekeepingActivity } = require("../db_models/housecleaning.model");
const { permissionsForRole, authorizePropertyRequest } = require("../services/property-permissions.service");
const { calendarDayRange } = require("../services/housekeeping-work.service");

test("Housekeeping API policy is an explicit, minimal allowlist", () => {
  const allowed = [["GET", "/properties/hotel-one"], ["GET", "/properties/hotel-one/theme"], ["GET", "/properties/hotel-one/images"], ["GET", "/properties/hotel-one/my-access"],
    ["GET", "/housekeeping/my-work"], ["GET", "/notifications"], ["PATCH", "/notifications/event/read"], ["POST", "/notifications/read-all"], ...["claim", "start", "complete"].map(action => ["POST", `/housekeeping/rooms/room-one/${action}`])];
  const denied = [["GET", "/housekeeping"], ["GET", "/housekeeping/activities"], ["GET", "/housekeeping/attendants"], ["GET", "/housekeeping/audit-log"],
    ...["assign", "request", "inspect"].map(action => ["POST", `/housekeeping/rooms/room-one/${action}`]),
    ["POST", "/housekeeping/attendants"], ["PATCH", "/housekeeping/attendants/worker"], ["GET", "/rooms"], ["GET", "/rates"], ["GET", "/guests"],
    ["GET", "/bookings/reservations"], ["GET", "/reports/dashboard"], ["POST", "/reports/generate"], ["GET", "/invoices"], ["GET", "/transactions"],
    ["GET", "/withdrawals"], ["GET", "/night-audit"], ["GET", "/properties/hotel-one/access"], ["PATCH", "/properties/hotel-one/info"]];
  for (const [method, path] of [...allowed, ...denied]) {
    let passed = false, code;
    const res = { status(value) { code = value; return this; }, json() { return this; } };
    authorizePropertyRequest({ propertyRole: "housekeeping", method, path }, res, () => { passed = true; });
    assert.equal(passed, allowed.some(([verb, route]) => verb === method && route === path), `${method} ${path}`);
    if (!passed) assert.equal(code, 403);
  }
  assert.deepEqual(permissionsForRole("housekeeping"), ["housekeeping.self.read", "housekeeping.self.manage"]);
});

test("completed-today boundaries follow the property timezone, including DST", () => {
  const colombo = calendarDayRange(new Date("2026-10-27T01:00:00Z"), "Asia/Colombo");
  assert.equal(colombo.date, "2026-10-27"); assert.equal(colombo.start.toISOString(), "2026-10-26T18:30:00.000Z");
  assert.equal(colombo.end.toISOString(), "2026-10-27T18:30:00.000Z");
  const spring = calendarDayRange(new Date("2026-03-08T12:00:00Z"), "America/New_York");
  assert.equal((spring.end - spring.start) / 3600000, 23);
  const fall = calendarDayRange(new Date("2026-11-01T12:00:00Z"), "America/New_York");
  assert.equal((fall.end - fall.start) / 3600000, 25);
  assert.equal(calendarDayRange(new Date(), "invalid-zone").timeZone, "Asia/Colombo");
});

test("property validation requires a unique attendant link for each Housekeeping login", async () => {
  const a = new mongoose.Types.ObjectId(), b = new mongoose.Types.ObjectId(), attendantId = new mongoose.Types.ObjectId();
  const raw = { property_id: "housekeeping-test", member_ids: [a, b], info: { hotel_name: "Hotel", address: "Road", country_code: "LK", email: "hotel@example.test" } };
  await assert.rejects(new Property({ ...raw, staff_roles: [{ user_id: a, role: "housekeeping" }] }).validate(), /linked attendant/);
  await assert.rejects(new Property({ ...raw, staff_roles: [a, b].map(user_id => ({ user_id, role: "housekeeping", attendant_id: attendantId })) }).validate(), /linked attendant/);
  await new Property({ ...raw, staff_roles: [{ user_id: a, role: "housekeeping", attendant_id: attendantId }] }).validate();
});

function matches(record, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") return expected.some(condition => matches(record, condition));
    const value = field.split(".").reduce((result, key) => result?.[key], record);
    if (expected === null) return value == null;
    if (expected && typeof expected === "object" && !(expected instanceof mongoose.Types.ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, wanted]) => op === "$in" ? wanted.some(item => String(item) === String(value)) : op === "$ne" ? String(value) !== String(wanted)
        : op === "$gte" ? new Date(value) >= wanted : op === "$lt" ? new Date(value) < wanted : op === "$exists" ? (value !== undefined) === wanted : true);
    }
    return String(value) === String(expected);
  });
}
function query(value) { return { select() { return this; }, session() { return this; }, sort() { return this; }, limit(limit) { if (Array.isArray(value)) value = value.slice(0, limit); return this; }, lean() { return this; },
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }

test("JWT Housekeeping access links accounts, isolates tasks, serializes claims, completes work and revokes immediately on the next request", async (t) => {
  process.env.JWT_SECRET = "isolated-housekeeping-role-test";
  const makeUser = name => ({ _id: new mongoose.Types.ObjectId(), name, email: `${name}@example.test`, role: "user" });
  const owner = makeUser("owner"), admin = makeUser("admin"), a = makeUser("worker-a"), b = makeUser("worker-b"), users = [owner, admin, a, b];
  const propertyId = "hotel-housekeeping-role";
  let property = new Property({ property_id: propertyId, owner_id: owner._id, member_ids: [admin._id], administrator_ids: [admin._id],
    info: { hotel_name: "Hotel", address: "Road", country_code: "LK", email: "hotel@example.test", invoice_footer: "PRIVATE_FINANCE_MARKER", timezone: "Asia/Colombo" } }).toObject();
  const workers = [a, b].map((user, index) => new HousekeepingAttendant({ property_id: propertyId, name: user.name, employee_number: `HK-${index}`, status: "active" }));
  const foreign = new HousekeepingAttendant({ property_id: "other-hotel", name: "Foreign", employee_number: "HK-F" }); workers.push(foreign);
  const roomType = new RoomType({ property_id: propertyId, name: "Standard", active: true, physical_rooms: ["101", "102", "103", "104"].map(room_number => ({ room_number, active: true, floor: "Ground", operational_status: "available", housekeeping_status: "dirty" })) });
  const tasks = roomType.physical_rooms.map((room, index) => new HousekeepingTask({ property_id: propertyId, physical_room_id: room._id, room_type_id: roomType._id, room_number: room.room_number,
    room_type_name: "Standard", status: index === 0 || index === 3 ? "assigned" : "requested", attendant: index === 0 || index === 3 ? { attendant_id: workers[index === 0 ? 0 : 1]._id, name: workers[index === 0 ? 0 : 1].name } : {},
    notes: index === 3 ? "PRIVATE_OTHER_TASK_NOTES" : "Housekeeping notes", requested_at: new Date(), requested_by: { name: "Front Desk", email: "PRIVATE_STAFF_EMAIL" } }));
  // A different hotel's task must not leak through the shared assignment list.
  tasks.push(new HousekeepingTask({ property_id: "other-hotel", physical_room_id: new mongoose.Types.ObjectId(), room_type_id: new mongoose.Types.ObjectId(), room_number: "PRIVATE_FOREIGN_ROOM", room_type_name: "Foreign",
    status: "assigned", attendant: { attendant_id: foreign._id, name: "PRIVATE_FOREIGN_WORKER" } }));
  const activities = [], audits = [];
  let transactionQueue = Promise.resolve();
  t.mock.method(mongoose, "startSession", async () => ({ async withTransaction(work) { const previous = transactionQueue; let release; transactionQueue = new Promise(resolve => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }, async endSession() {} }));
  t.mock.method(Guard, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(User, "findById", id => query(users.find(user => String(user._id) === String(id))));
  t.mock.method(User, "findOne", filter => query(users.find(user => matches(user, filter))));
  t.mock.method(User, "find", filter => query(users.filter(user => matches(user, filter))));
  t.mock.method(Property, "findOne", filter => query(filter.property_id === propertyId ? new Property(property) : null));
  t.mock.method(Property, "find", () => query([new Property(property)]));
  t.mock.method(Property.prototype, "save", async function () { await this.validate(); property = this.toObject(); return this; });
  t.mock.method(HousekeepingAttendant, "findOne", filter => query(workers.find(worker => matches(worker, filter)) || null));
  t.mock.method(HousekeepingAttendant, "find", filter => query(workers.filter(worker => matches(worker, filter))));
  t.mock.method(RoomType, "findOne", filter => query(filter.property_id === propertyId && roomType.physical_rooms.id(filter["physical_rooms._id"]) ? roomType : null));
  t.mock.method(RoomType, "find", filter => query(filter.property_id === propertyId ? [roomType.toObject()] : []));
  t.mock.method(RoomType.prototype, "save", async function () { return this; });
  t.mock.method(HousekeepingTask, "findOne", filter => query(tasks.find(task => matches(task, filter)) || null));
  t.mock.method(HousekeepingTask, "find", filter => query(tasks.filter(task => matches(task, filter))));
  t.mock.method(HousekeepingTask.prototype, "save", async function () { await this.validate(); return this; });
  t.mock.method(HousekeepingActivity, "find", filter => query(activities.filter(activity => matches(activity, filter))));
  t.mock.method(HousekeepingActivity, "create", async values => { const records = values.map(value => new HousekeepingActivity(value)); activities.push(...records); return records; });
  t.mock.method(Audit, "create", async values => { audits.push(...values); return values; });
  const { app } = require("../app"); const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (user, path, method = "GET", input = {}, hotel = propertyId) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
    headers: { Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`, "x-property-id": hotel, "Content-Type": "application/json", "x-user-id": String(b._id) },
    ...(method === "GET" ? {} : { body: JSON.stringify(input) }) });
  const access = `/properties/${propertyId}/access`;
  assert.equal((await request(owner, access, "POST", { email: a.email, role: "housekeeping" })).status, 400);
  assert.equal((await request(owner, access, "POST", { email: a.email, role: "housekeeping", attendant_id: foreign._id })).status, 400);
  assert.equal((await request(admin, access, "POST", { email: a.email, role: "housekeeping", attendant_id: workers[0]._id })).status, 201);
  assert.equal((await request(admin, access, "POST", { email: b.email, role: "housekeeping", attendant_id: workers[0]._id })).status, 409);
  assert.equal((await request(admin, access, "POST", { email: b.email, role: "housekeeping", attendant_id: workers[1]._id })).status, 201);
  const members = await (await request(owner, access)).json();
  assert.equal(members.members.find(member => member.id === String(a._id)).attendant_id, String(workers[0]._id));
  const brand = await (await request(a, `/properties/${propertyId}`)).json();
  assert.equal(brand.property.info.hotel_name, "Hotel"); assert.equal(brand.property.owner_id, undefined); assert.equal(brand.property.info.invoice_footer, undefined);
  for (const path of ["/housekeeping", "/housekeeping/activities", "/housekeeping/attendants", "/bookings/reservations", "/rooms", "/invoices", "/rates", "/reports/dashboard", "/night-audit", access]) assert.equal((await request(a, path)).status, 403, path);
  const taskPath = index => `/housekeeping/rooms/${roomType.physical_rooms[index]._id}`;
  for (const action of ["assign", "request", "inspect"]) assert.equal((await request(a, `${taskPath(0)}/${action}`, "POST", { attendant_id: workers[1]._id })).status, 403);
  let work = await (await request(a, "/housekeeping/my-work")).json();
  assert.equal(work.assigned.length, 1); assert.equal(work.assigned[0].room_number, "101"); assert.equal(work.requests.length, 2);
  assert.ok(!JSON.stringify(work).includes("PRIVATE_"));
  assert.equal(work.team_assignments.length, 1);
  assert.equal(work.team_assignments[0].room_number, "104");
  assert.equal(work.team_assignments[0].attendant_name, workers[1].name);
  assert.equal(work.team_assignments[0].status, "assigned");
  assert.ok(Object.keys(work.team_assignments[0]).every(key => ["id", "room_number", "room_type", "status", "attendant_name", "assigned_at", "started_at"].includes(key)));
  assert.equal((await request(a, `${taskPath(3)}/start`, "POST", { attendant_id: workers[1]._id, user_id: b._id })).status, 403);
  assert.equal((await request(a, `${taskPath(3)}/complete`, "POST")).status, 403);
  assert.equal((await request(a, `${taskPath(0)}/complete`, "POST")).status, 409);
  const claims = await Promise.all([a, b].map(user => request(user, `${taskPath(1)}/claim`, "POST", { attendant_id: foreign._id, user_id: owner._id, actor_role: "owner", actor: { name: "Forged actor" } })));
  assert.deepEqual(claims.map(response => response.status).sort(), [200, 409]);
  assert.ok([String(workers[0]._id), String(workers[1]._id)].includes(String(tasks[1].attendant.attendant_id)));
  const claimed = activities.find(activity => activity.action === "claimed");
  const winnerIndex = claims.findIndex(response => response.status === 200);
  assert.equal(claimed.actor.user_id, String([a, b][winnerIndex]._id));
  assert.equal(claimed.actor.name, [a, b][winnerIndex].name);
  assert.equal(claimed.actor_role, "housekeeping");
  assert.ok(audits.some(entry => entry.action === "housekeeping_claimed"));
  assert.equal((await request(a, `${taskPath(0)}/start`, "POST")).status, 200);
  const teamView = await (await request(b, "/housekeeping/my-work")).json();
  assert.equal(teamView.team_assignments.find(task => task.room_number === "101").status, "in_progress");
  assert.equal(teamView.team_assignments.find(task => task.room_number === "101").attendant_name, workers[0].name);
  assert.equal((await request(a, `${taskPath(2)}/claim`, "POST")).status, 409);
  assert.equal((await request(a, `${taskPath(0)}/complete`, "POST", { notes: "Fresh linen placed", status: "inspected", user_id: b._id })).status, 200);
  assert.equal(tasks[0].status, "completed"); assert.equal(roomType.physical_rooms[0].housekeeping_status, "clean");
  assert.ok(!(await (await request(b, "/housekeeping/my-work")).json()).team_assignments.some(task => task.room_number === "101"));
  assert.equal((await request(a, `${taskPath(0)}/complete`, "POST")).status, 409);
  work = await (await request(a, "/housekeeping/my-work")).json();
  assert.equal(work.completed_today.length, 1); assert.equal(work.completed_today[0].notes, "Fresh linen placed");
  assert.equal(activities.find(activity => activity.action === "cleaning_completed").actor.user_id, String(a._id));
  assert.equal(activities.find(activity => activity.action === "cleaning_started").actor_role, "housekeeping");
  assert.equal(activities.find(activity => activity.action === "cleaning_completed").actor_role, "housekeeping");
  // The action's actor is independent of the assigned worker, including when
  // administrators/owners perform operations on the worker's behalf.
  assert.equal((await request(admin, `${taskPath(3)}/assign`, "POST", { attendant_id: workers[1]._id })).status, 200);
  assert.equal((await request(admin, `${taskPath(3)}/start`, "POST")).status, 200);
  assert.equal((await request(owner, `${taskPath(3)}/complete`, "POST", { notes: "Owner confirmed cleaning", actor_role: "housekeeping" })).status, 200);
  for (const [action, user, role] of [["assigned", admin, "administrator"], ["cleaning_started", admin, "administrator"], ["cleaning_completed", owner, "owner"]]) {
    const event = activities.find(activity => activity.action === action && activity.room_number === "104");
    assert.equal(event.actor.user_id, String(user._id));
    assert.equal(event.actor.name, user.name);
    assert.equal(event.actor_role, role);
    assert.equal(String(event.attendant.attendant_id), String(workers[1]._id));
  }
  assert.equal((await request(owner, `${taskPath(0)}/request`, "POST")).status, 201);
  const requested = activities.find(activity => activity.action === "requested" && activity.room_number === "101");
  assert.equal(requested.actor.user_id, String(owner._id)); assert.equal(requested.actor_role, "owner");
  assert.equal((await (await request(a, "/housekeeping/my-work")).json()).completed_today.length, 1); // immutable history survives room-task reuse
  workers[0].status = "inactive";
  assert.equal((await request(a, "/housekeeping/my-work")).status, 403); workers[0].status = "active";
  assert.equal((await request(a, "/housekeeping/my-work", "GET", {}, "another-hotel")).status, 403);
  assert.equal((await request(admin, `${access}/${a._id}`, "PATCH", { role: "front_desk" })).status, 200);
  assert.equal((await request(a, "/housekeeping/my-work")).status, 403);
  assert.equal(property.staff_roles.find(link => String(link.user_id) === String(a._id)).attendant_id, undefined);
  assert.equal(activities.find(activity => activity.action === "cleaning_started" && activity.room_number === "101").actor_role, "housekeeping"); // historical role snapshot survives demotion
  assert.ok(audits.some(entry => entry.changes?.some(change => change.field === `attendant_link.${a._id}`)));
});
