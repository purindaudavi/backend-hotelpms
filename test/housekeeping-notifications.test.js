const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Property = require("../db_models/property.model");
const User = require("../db_models/user.model");
const State = require("../db_models/notification-read-state.model");
const { HousekeepingActivity: Activity, HousekeepingTask: Task, HousekeepingAttendant: Attendant } = require("../db_models/housecleaning.model");
const { listPropertyNotifications, notificationSources } = require("../services/notification.service");
const id = () => new mongoose.Types.ObjectId();
function matches(record, filter) {
  return Object.entries(filter).every(([field, wanted]) => {
    if (field === "$or") return wanted.some(item => matches(record, item));
    const value = field.split(".").reduce((item, key) => item?.[key], record);
    if (wanted === null) return value == null;
    if (wanted && typeof wanted === "object" && !(wanted instanceof mongoose.Types.ObjectId) && !(wanted instanceof Date)) {
      if (wanted.$in) return wanted.$in.some(item => String(item) === String(value));
      if (wanted.$gte) return new Date(value) >= new Date(wanted.$gte);
    }
    return String(value) === String(wanted);
  });
}
function query(value) {
  return { session() { return this; }, select() { return this; }, lean() { return this; },
    sort() { if (Array.isArray(value)) value.sort((a, b) => b.created_at - a.created_at); return this; },
    limit(count) { if (Array.isArray(value)) value = value.slice(0, count); return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}
test("housekeeping alerts isolate attendants before pagination, check claimable requests and protect read state across role/link changes", async t => {
  process.env.JWT_SECRET = "isolated-housekeeping-notification-test";
  const make = name => ({ _id: id(), name, email: `${name}@example.test`, role: "user" });
  const owner = make("owner"), admin = make("admin"), a = make("keeper-a"), b = make("keeper-b"), fd = make("frontdesk"), stranger = make("outsider");
  const users = [owner, admin, a, b, fd, stranger], propertyId = "notification-housekeeping";
  const attendants = [a, b].map(user => ({ _id: id(), property_id: propertyId, name: user.name, status: "active" }));
  const property = new Property({ property_id: propertyId, owner_id: owner._id, member_ids: [admin._id, a._id, b._id, fd._id], administrator_ids: [admin._id],
    staff_roles: [{ user_id: a._id, role: "housekeeping", attendant_id: attendants[0]._id }, { user_id: b._id, role: "housekeeping", attendant_id: attendants[1]._id }, { user_id: fd._id, role: "front_desk" }],
    info: { hotel_name: "Test Hotel", address: "Street", country_code: "LK", email: "hotel@example.test" } });
  const now = Date.now(), taskId = id(), roomId = id();
  const tasks = [{ _id: taskId, property_id: propertyId, physical_room_id: roomId, status: "requested", attendant: {}, requested_at: new Date(now - 30000) }];
  const event = (action, ago, attendant, extra = {}) => ({ _id: id(), property_id: propertyId, action, task_id: taskId, physical_room_id: roomId,
    room_number: "T101", room_type_name: "Standard", actor: { name: "Verified Actor" }, attendant: attendant ? { attendant_id: attendant._id, name: attendant.name } : {}, created_at: new Date(now - ago), ...extra });
  const oldRequest = event("requested", 60000), openRequest = event("requested", 20000), assignedA = event("assigned", 10000, attendants[0]), assignedB = event("assigned", 5000, attendants[1]), claimedB = event("claimed", 4000, attendants[1]);
  const events = [oldRequest, openRequest, assignedA, assignedB, claimedB, event("requested", 1000, null, { property_id: "other-property" })];
  t.mock.method(User, "findById", key => query(users.find(user => String(user._id) === String(key)) || null));
  t.mock.method(Property, "findOne", filter => query(matches(property, filter) ? property : null));
  t.mock.method(Attendant, "findOne", filter => query(attendants.find(item => matches(item, filter)) || null));
  t.mock.method(Task, "find", filter => query(tasks.filter(item => matches(item, filter))));
  const activityFilters = [];
  t.mock.method(Activity, "find", filter => { activityFilters.push(filter); return query(events.filter(item => matches(item, filter))); });
  t.mock.method(Activity, "findOne", filter => query(events.find(item => matches(item, filter)) || null));
  let financialReads = 0;
  for (const source of notificationSources) {
    t.mock.method(source.model, "find", () => { financialReads++; return query([]); });
    t.mock.method(source.model, "findOne", () => query(null));
  }
  const states = new Map(), key = filter => `${filter.property_id}:${filter.user_id}`;
  t.mock.method(State, "findOne", filter => query(states.get(key(filter)) || null));
  t.mock.method(State, "findOneAndUpdate", (filter, update) => {
    const state = states.get(key(filter)) || { ...filter, read_notification_ids: [], read_through_by_type: {} };
    for (const [field, value] of Object.entries(update.$set || {})) {
      if (field.startsWith("read_through_by_type.")) state.read_through_by_type[field.split(".")[1]] = value; else state[field] = value;
    }
    state.save = async () => { states.set(key(filter), state); return state; };
    states.set(key(filter), state); return query(state);
  });
  const { app } = require("../app"), server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (user, suffix = "", method = "GET", otherProperty = propertyId) => fetch(`http://127.0.0.1:${server.address().port}/api/notifications${suffix}${method === "GET" ? `?property_id=${otherProperty}&limit=100&role=owner&attendant_id=${attendants[1]._id}` : ""}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`, "Content-Type": "application/json", "x-user-id": String(owner._id) },
    ...(method !== "GET" ? { body: JSON.stringify({ property_id: otherProperty, attendant_id: attendants[1]._id, role: "owner" }) } : {}) });
  const feed = async user => { const response = await call(user); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const notificationId = (type, record) => `${type}:${record._id}`;
  const aFeed = await feed(a); assert.equal(aFeed.unread_count, 2); assert.equal(financialReads, 0);
  assert.ok(aFeed.notifications.some(item => item.id === notificationId("housekeeping_request", openRequest)));
  assert.ok(aFeed.notifications.some(item => item.id === notificationId("housekeeping_assignment", assignedA)));
  assert.ok(aFeed.notifications.every(item => !JSON.stringify(item).includes(b.name)));
  assert.equal((await listPropertyNotifications(propertyId, 1, "housekeeping", { attendant_id: attendants[0]._id }))[0].id, notificationId("housekeeping_assignment", assignedA));
  assert.deepEqual(await listPropertyNotifications(propertyId, 30, "housekeeping"), []);
  assert.equal(activityFilters.filter(filter => filter["attendant.attendant_id"]).every(filter => String(filter["attendant.attendant_id"]) === String(attendants[0]._id)), true);
  const bFeed = await feed(b); assert.equal(bFeed.notifications.length, 3);
  const ownerFeed = await feed(owner), adminFeed = await feed(admin); assert.equal(ownerFeed.notifications.length, 5); assert.equal(adminFeed.notifications.length, 5);
  assert.ok(ownerFeed.notifications.find(item => item.id === notificationId("housekeeping_assignment", claimedB)).title.includes("claimed"));
  assert.ok(aFeed.notifications.find(item => item.type === "housekeeping_request").href.endsWith("?room=T101&tab=requests"));
  assert.ok(aFeed.notifications.find(item => item.type === "housekeeping_assignment").href.endsWith("?room=T101&tab=assigned"));
  assert.equal((await feed(fd)).notifications.length, 0);
  assert.equal((await call(a, `/${notificationId("housekeeping_assignment", assignedB)}/read`, "PATCH")).status, 404);
  assert.equal((await call(a, `/${notificationId("housekeeping_request", oldRequest)}/read`, "PATCH")).status, 404);
  assert.equal((await call(a, `/invoice:${id()}/read`, "PATCH")).status, 404);
  assert.equal((await call(a, "/read-all", "POST")).status, 200);
  assert.equal((await feed(a)).unread_count, 0); assert.equal((await feed(b)).unread_count, 3);
  const aState = states.get(`${propertyId}:${a._id}`); assert.equal(aState.read_through_at, undefined); assert.deepEqual(aState.read_through_by_type, {});
  assert.equal(aState.read_notification_ids.length, 2); assert.ok(!states.has(`${propertyId}:${owner._id}`));
  property.staff_roles = property.staff_roles.filter(item => String(item.user_id) !== String(b._id));
  property.staff_roles.find(item => String(item.user_id) === String(a._id)).attendant_id = attendants[1]._id;
  const relinked = await feed(a); assert.equal(relinked.unread_count, 2, "read-all must not clear another attendant's hidden alerts");
  tasks[0].status = "assigned"; tasks[0].attendant = { attendant_id: attendants[1]._id };
  assert.equal((await feed(a)).notifications.some(item => item.type === "housekeeping_request"), false);
  assert.equal((await call(a, `/${notificationId("housekeeping_request", openRequest)}/read`, "PATCH")).status, 404);
  assert.equal((await feed(owner)).notifications.length, 5, "Owner/Admin retain immutable request history after claims");
  attendants[1].status = "inactive";
  assert.equal((await call(a)).status, 403); assert.equal((await call(a, "/read-all", "POST")).status, 403);
  assert.equal((await call(stranger)).status, 403); assert.equal((await call(a, "", "GET", "other-property")).status, 403);
});
