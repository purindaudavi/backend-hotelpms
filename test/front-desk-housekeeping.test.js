const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const express = require("express");
const RoomType = require("../db_models/rooms.model");
const { HousekeepingTask, HousekeepingAttendant, HousekeepingActivity } = require("../db_models/housecleaning.model");
const Guard = require("../db_models/inventory-guard.model");
const Audit = require("../db_models/booking-log.model");
const { authorizePropertyRequest } = require("../services/property-permissions.service");

function query(value) { return { session() { return this; }, sort() { return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }

test("Front Desk assigns only active same-property attendants to serviceable rooms, with audit history", async (t) => {
  const propertyId = "hotel-housekeeping";
  const roomType = new RoomType({ property_id: propertyId, name: "Standard", physical_rooms: [{ room_number: "101", active: true, operational_status: "available", housekeeping_status: "dirty" }] });
  const room = roomType.physical_rooms[0];
  const attendant = new HousekeepingAttendant({ property_id: propertyId, employee_number: "HK-01", name: "Test Attendant", status: "active" });
  let savedTask = null;
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Guard, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(RoomType, "findOne", (filter) => query(filter.property_id === propertyId && String(filter["physical_rooms._id"]) === String(room._id) ? roomType : null));
  t.mock.method(HousekeepingTask, "findOne", (filter) => query(filter.status ? null : savedTask));
  t.mock.method(RoomType.prototype, "save", async function () { return this; });
  t.mock.method(HousekeepingAttendant, "findOne", (filter) => query(filter.property_id === propertyId && String(filter._id) === String(attendant._id) ? attendant : null));
  t.mock.method(HousekeepingTask.prototype, "save", async function (options) { assert.equal(options.session, session); await this.validate(); savedTask = this; return this; });
  const activities = [], audits = [];
  t.mock.method(HousekeepingActivity, "create", async (values, options) => { assert.equal(options.session, session); activities.push(...values); return values; });
  t.mock.method(Audit, "create", async (values) => { audits.push(...values); return values; });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.propertyRole = "front_desk"; authorizePropertyRequest(req, res, next); });
  app.use("/housekeeping", require("../routes/housecleaning"));
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (path, input = {}, property = propertyId, method = "POST") => fetch(`http://127.0.0.1:${server.address().port}/housekeeping${path}`, {
    method, headers: { "x-property-id": property, "x-user-id": "front-desk-user", "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const path = `/rooms/${room._id}`;
  assert.equal((await request(`${path}/assign`, { attendant_id: attendant._id })).status, 200);
  assert.equal(String(savedTask.attendant.attendant_id), String(attendant._id));
  assert.equal(room.housekeeping_status, "dirty"); // assigning never certifies the room clean
  assert.equal(activities[0].action, "assigned"); assert.equal(audits[0].actor.user_id, "front-desk-user");
  assert.equal(activities[0].actor_role, "front_desk");
  for (const operation of ["start", "complete", "inspect"]) assert.equal((await request(`${path}/${operation}`)).status, 403);
  assert.equal((await request("/attendants", { name: "Forbidden" })).status, 403);
  assert.equal((await request(`/attendants/${attendant._id}`, {}, propertyId, "PATCH")).status, 403);
  assert.equal((await request(`${path}/assign`, { attendant_id: new mongoose.Types.ObjectId() })).status, 404);
  assert.equal((await request(`${path}/assign`, { attendant_id: attendant._id }, "another-hotel")).status, 404);
  attendant.status = "inactive";
  assert.equal((await request(`${path}/assign`, { attendant_id: attendant._id })).status, 409);
  attendant.status = "active";
  for (const status of ["occupied", "maintenance", "out_of_order"]) {
    room.operational_status = status;
    assert.equal((await request(`${path}/assign`, { attendant_id: attendant._id })).status, 409);
  }
  assert.equal(activities.length, 1); assert.equal(audits.length, 1);
});

test("Owner/Admin create attendants; Front Desk requests or assigns available attendants, and starts serialize per worker", async (t) => {
  const propertyId = "hotel-requests";
  const roomType = new RoomType({ property_id: propertyId, name: "Standard", active: true, physical_rooms: ["101", "102", "103"].map(room_number => ({ room_number, active: true, operational_status: "available", housekeeping_status: room_number === "103" ? "clean" : "dirty" })) });
  const attendants = [new HousekeepingAttendant({ property_id: propertyId, employee_number: "HK-01", name: "Worker One", status: "active" })];
  const attendant = attendants[0], tasks = new Map(), activities = [], audits = [];
  let transactionQueue = Promise.resolve();
  t.mock.method(mongoose, "startSession", async () => ({
    async withTransaction(work) {
      const previous = transactionQueue;
      let release; transactionQueue = new Promise(resolve => { release = resolve; });
      await previous;
      try { return await work(); } finally { release(); }
    }, async endSession() {}
  }));
  t.mock.method(Guard, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(RoomType, "findOne", (filter) => query(filter.property_id === propertyId && roomType.physical_rooms.id(filter["physical_rooms._id"]) ? roomType : null));
  t.mock.method(RoomType, "find", () => query([roomType]));
  t.mock.method(RoomType.prototype, "save", async function () { return this; });
  t.mock.method(HousekeepingTask, "find", () => query([...tasks.values()]));
  t.mock.method(HousekeepingTask, "findOne", (filter) => query(filter.status
    ? [...tasks.values()].find(task => task.status === filter.status && String(task.attendant?.attendant_id) === String(filter["attendant.attendant_id"]) && String(task.physical_room_id) !== String(filter.physical_room_id.$ne)) || null
    : tasks.get(String(filter.physical_room_id)) || null));
  t.mock.method(HousekeepingTask.prototype, "save", async function () { await this.validate(); tasks.set(String(this.physical_room_id), this); return this; });
  t.mock.method(HousekeepingAttendant, "findOne", (filter) => query(attendants.find(worker => String(worker._id) === String(filter._id) && worker.property_id === filter.property_id && (!filter.status || worker.status === filter.status)) || null));
  t.mock.method(HousekeepingAttendant, "find", () => query(attendants));
  t.mock.method(HousekeepingAttendant.prototype, "save", async function () { await this.validate(); if (!attendants.includes(this)) attendants.push(this); return this; });
  t.mock.method(HousekeepingActivity, "find", () => query(activities));
  t.mock.method(HousekeepingActivity, "create", async values => { activities.push(...values); return values; });
  t.mock.method(Audit, "create", async values => { audits.push(...values); return values; });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.propertyRole = req.get("x-test-role") || "front_desk"; authorizePropertyRequest(req, res, next); });
  app.use("/housekeeping", require("../routes/housecleaning"));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path = "", input = {}, role = "front_desk", method = "POST", hotel = propertyId) => fetch(`http://127.0.0.1:${server.address().port}/housekeeping${path}`, {
    method, headers: { "x-property-id": hotel, "x-test-role": role, "x-user-name": role, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(input) }) });
  const paths = roomType.physical_rooms.map(room => `/rooms/${room._id}`);
  for (const role of ["front_desk", "member"]) assert.equal((await request("/attendants", { employee_number: role, name: role }, role)).status, 403);
  for (const role of ["owner", "administrator"]) assert.equal((await request("/attendants", { employee_number: role, name: role }, role)).status, 201);
  assert.equal((await request(`${paths[0]}/request`, { priority: "urgent", notes: "Prepare for early arrival" })).status, 201);
  let task = tasks.get(String(roomType.physical_rooms[0]._id));
  assert.equal(task.status, "requested"); assert.equal(task.attendant?.attendant_id, undefined); assert.equal(task.requested_by.name, "front_desk");
  assert.equal(task.notes, "Prepare for early arrival"); assert.equal(activities[0].action, "requested");
  assert.equal((await request(`${paths[0]}/request`)).status, 409);
  let board = await (await request("", {}, "front_desk", "GET")).json();
  assert.equal(board.rooms[0].task.status, "requested"); assert.equal(board.attendants[0].available, true);
  // Multiple assigned rooms form a queue; only one can actually be in progress.
  for (const path of paths.slice(0, 2)) assert.equal((await request(`${path}/assign`, { attendant_id: attendant._id })).status, 200);
  const starts = await Promise.all(paths.slice(0, 2).map((path, index) => request(`${path}/start`, {}, index ? "administrator" : "owner")));
  assert.deepEqual(starts.map(response => response.status).sort(), [200, 409]);
  const working = [...tasks.values()].filter(task => task.status === "in_progress");
  assert.equal(working.length, 1);
  assert.equal((await request(`${paths[2]}/assign`, { attendant_id: attendant._id })).status, 409);
  assert.equal((await request(`${paths[2]}/request`, { priority: "high" })).status, 201);
  assert.equal(roomType.physical_rooms[2].housekeeping_status, "dirty");
  board = await (await request("", {}, "front_desk", "GET")).json();
  const worker = board.attendants.find(worker => worker._id === String(attendant._id));
  assert.equal(worker.available, false); assert.deepEqual(worker.busy_rooms, [working[0].room_number]); assert.equal(worker.queued_rooms.length, 1);
  const workingPath = `/rooms/${working[0].physical_room_id}`;
  assert.equal((await request(`${workingPath}/assign`, { attendant_id: attendants[1]._id }, "owner")).status, 409);
  assert.equal((await request(`${workingPath}/complete`, {}, "front_desk")).status, 403);
  assert.equal((await request(`${workingPath}/complete`, {}, "owner")).status, 200);
  assert.equal((await request(`${paths[2]}/assign`, { attendant_id: attendant._id })).status, 200);
  assert.equal(tasks.get(String(roomType.physical_rooms[2]._id)).status, "assigned");
  for (const operation of ["request", "assign"]) assert.equal((await request(`${paths[2]}/${operation}`, { attendant_id: attendant._id }, "member")).status, 403);
  assert.equal((await request(`${paths[2]}/request`, {}, "front_desk", "POST", "another-property")).status, 404);
  assert.ok(audits.some(entry => entry.action === "housekeeping_requested"));
});
