require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fork } = require("node:child_process");
const express = require("express");
const mongoose = require("mongoose");
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
const { connectDatabase, disconnectDatabase } = require("../config/database");
const RoomType = require("../db_models/rooms.model");
const Reservation = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");
const InventoryGuard = require("../db_models/inventory-guard.model");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const CrossBooking = require("../db_models/crossbooking.model");
const Guest = require("../db_models/guest.model");
const Invoice = require("../db_models/invoice.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const DocumentCounter = require("../db_models/document-counter.model");
const FinancialTransaction = require("../db_models/financial-transaction.model");
const { HousekeepingTask, HousekeepingActivity } = require("../db_models/housecleaning.model");
const { withInventoryTransaction } = require("../services/inventory-transaction.service");
const { validateReservationInventory } = require("../services/booking-availability.service");
const { createSimulatedOtaReservation } = require("../services/ota-simulator.service");

function payload(propertyId, type, overrides = {}) {
  return {
    property_id: propertyId, status: "tentative", check_in: "2026-10-20", check_out: "2026-10-22",
    booking_source: "Direct", currency: "LKR",
    booker: { name: "Synthetic concurrency guest", email: `${randomUUID()}@example.com`, phone: "+94710000000", country: "Sri Lanka" },
    rooms: [{ room_type_id: type._id, room_type_name: type.name, adults: 1, children: 0,
      currency: "LKR", original_nightly_rate: 6500, effective_nightly_rate: 6500 }],
    financial_summary: { room_total: 13000, grand_total: 13000, paid_total: 0 }, ...overrides
  };
}

async function worker() {
  const [, , , propertyId, typeId] = process.argv;
  assert.match(propertyId, /^concurrency-smoke-[0-9a-f-]{36}-\d+$/);
  await connectDatabase();
  process.send({ ready: true });
  await new Promise((resolve) => process.once("message", resolve));
  try {
    await withInventoryTransaction(propertyId, async (session) => {
      const record = new Reservation({
        ...payload(propertyId, { _id: typeId, name: "Concurrent Standard" }),
        reservation_no: `WORKER-${randomUUID()}`
      });
      await record.validate();
      await validateReservationInventory({ propertyId, checkIn: record.check_in, checkOut: record.check_out, rooms: record.rooms, session });
      // Make the read/save race window deliberately large. Without the shared
      // guard both processes could read one room free before either inserts.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await record.save({ session });
    });
    process.send({ status: 201 });
  } catch (error) {
    process.send({ status: error.statusCode || 500, message: error.message });
  } finally {
    await disconnectDatabase();
    process.disconnect();
  }
}

async function workerRace(propertyId, typeId) {
  const children = [0, 1].map(() => fork(__filename, ["--worker", propertyId, String(typeId)], { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  const deadline = setTimeout(() => children.forEach((child) => child.kill()), 30000);
  let completed = false;
  try {
    const ready = children.map((child) => new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Worker exited before readiness (${code}).`)));
      child.once("message", (message) => message.ready ? resolve() : reject(new Error("Worker failed to start.")));
    }));
    await Promise.all(ready);
    const results = children.map((child) => new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Worker exited before reporting (${code}).`)));
      child.once("message", resolve);
    }));
    children.forEach((child) => child.send({ start: true }));
    const values = await Promise.all(results);
    completed = true;
    return values;
  } finally {
    clearTimeout(deadline);
    if (!completed) children.forEach((child) => child.kill());
    // Wait for workers to finish database/session cleanup before fixture cleanup.
    await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve))));
  }
}

async function main() {
  if (!process.argv.includes("--run") || process.env.NODE_ENV === "production") {
    throw new Error("Run with --run only against a development/test replica-set database, never production.");
  }
  const namespace = `concurrency-smoke-${randomUUID()}`;
  const properties = [];
  const servers = [];
  console.log(`Temporary test namespace: ${namespace}`);
  try {
    await connectDatabase();
    for (let index = 0; index < 2; index++) {
      // Loopback-only harness using the actual routers and MongoDB. It does not
      // replace or modify the running PMS server, nor bypass its authentication.
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        const propertyId = req.query.property_id || req.body?.property_id;
        if (!properties.includes(propertyId)) return res.status(403).json({ message: "This harness only accepts its own temporary test namespaces." });
        next();
      });
      app.use("/bookings", require("../routes/bookings"));
      app.use("/rooms", require("../routes/rooms"));
      app.use("/cross-bookings", require("../routes/crossbooking"));
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await new Promise((resolve) => server.once("listening", resolve));
    }
    const request = async (serverIndex, path, method, body) => {
      const response = await fetch(`http://127.0.0.1:${servers[serverIndex].address().port}${path}`, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    const fixture = async (capacity = 1) => {
      const propertyId = `${namespace}-${properties.length + 1}`;
      properties.push(propertyId);
      const type = await RoomType.create({ property_id: propertyId, name: "Concurrent Standard", base_rate: 6500,
        physical_rooms: Array.from({ length: capacity }, (_, index) => ({ room_number: String(101 + index) })) });
      return { propertyId, type };
    };
    const book = (index, propertyId, type, overrides) => request(index, "/bookings/reservations", "POST", payload(propertyId, type, overrides));
    const oneWinner = (results, successfulStatus = 201) => assert.deepEqual(results.map((item) => item.status).sort(), [successfulStatus, 409].sort(), JSON.stringify(results));
    const saveSeed = (propertyId, type, overrides) => Reservation.create({ ...payload(propertyId, type, overrides), reservation_no: `SEED-${randomUUID()}` });
    const seedBlock = (propertyId, type, status = "tentative") => BusinessBlock.create({
      property_id: propertyId, block_number: `BB-${randomUUID()}`, block_name: "Synthetic concurrent group", company_name: "Smoke test",
      check_in: "2026-10-20", check_out: "2026-10-22", cutoff_date: "2026-10-19", status,
      allocations: [{ room_type_id: type._id, room_type_name: type.name, quantity: 1, negotiated_rate: 0 }]
    });

    if (!process.argv.includes("--day-use-only") && !process.argv.includes("--room-moves-only")) {
      {
        const { propertyId, type } = await fixture();
        assert.equal(await InventoryGuard.countDocuments({ _id: propertyId }), 0);
        const results = await Promise.all([book(0, propertyId, type), book(1, propertyId, type)]);
        oneWinner(results);
        assert.equal(await Reservation.countDocuments({ property_id: propertyId }), 1);
        assert.equal(await Guest.countDocuments({ property_id: propertyId }), 1);
        const winner = results.find((item) => item.status === 201).body.reservation;
        const cancelled = await request(0, `/bookings/reservations/${winner._id}/cancel`, "POST", { property_id: propertyId, reason: "Synthetic cancellation test" });
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
        assert.equal((await book(1, propertyId, type)).status, 201);
        console.log("PASS: cold-start last-room race has one winner; cancellation releases it and failed work leaves no guest.");
      }
      {
        const { propertyId, type } = await fixture(2);
        const results = await Promise.all([book(0, propertyId, type), book(1, propertyId, type)]);
        assert.deepEqual(results.map((item) => item.status), [201, 201], JSON.stringify(results));
        console.log("PASS: both requests succeed when two rooms really are available.");
      }
      {
        const { propertyId, type } = await fixture(2);
        const rooms = payload(propertyId, type).rooms;
        oneWinner(await Promise.all([0, 1].map((index) => book(index, propertyId, type, { rooms: [rooms[0], rooms[0]] }))));
        const records = await Reservation.find({ property_id: propertyId });
        assert.equal(records.length, 1);
        assert.equal(records[0].rooms.length, 2);
        console.log("PASS: competing two-room requests save all-or-nothing without partial reservations.");
      }
      {
        const { propertyId, type } = await fixture();
        const results = await Promise.all([
          book(0, propertyId, type, { check_out: "2026-10-21" }),
          book(1, propertyId, type, { check_in: "2026-10-21" })
        ]);
        assert.deepEqual(results.map((item) => item.status), [201, 201], JSON.stringify(results));
        console.log("PASS: non-overlapping nights still accept both bookings.");
      }
      {
        const { propertyId, type } = await fixture(2);
        const result = await request(0, "/cross-bookings", "POST", { property_id: propertyId, room_a_id: type.physical_rooms[0]._id, room_b_id: type.physical_rooms[1]._id });
        assert.equal(result.status, 201, JSON.stringify(result));
        oneWinner(await Promise.all([0, 1].map((index) => book(index, propertyId, type, {
          rooms: [{ ...payload(propertyId, type).rooms[0], physical_room_id: type.physical_rooms[index]._id }]
        }))));
        const linkId = result.body.cross_booking._id;
        for (const active of [false, true]) {
          const changed = await request(0, `/cross-bookings/${linkId}`, "PATCH", { property_id: propertyId, active });
          assert.equal(changed.status, 200, JSON.stringify(changed));
        }
        const removed = await request(0, `/cross-bookings/${linkId}?property_id=${propertyId}`, "DELETE");
        assert.equal(removed.status, 200, JSON.stringify(removed));
        console.log("PASS: competing cross-linked physical rooms cannot both be booked.");
      }
      {
        const { propertyId, type } = await fixture();
        const first = await saveSeed(propertyId, type, { check_in: "2026-10-20", check_out: "2026-10-21" });
        const second = await saveSeed(propertyId, type, { check_in: "2026-10-24", check_out: "2026-10-25" });
        oneWinner(await Promise.all([first, second].map((record, index) => request(index, `/bookings/reservations/${record._id}`, "PATCH", {
          property_id: propertyId, check_in: "2026-10-22", check_out: "2026-10-23"
        }))), 200);
        assert.equal(await Reservation.countDocuments({ property_id: propertyId, check_in: new Date("2026-10-22") }), 1);
        console.log("PASS: competing date edits cannot claim the same final room.");
      }
      {
        const { propertyId, type } = await fixture();
        const block = await seedBlock(propertyId, type);
        const results = await Promise.all([
          request(0, `/bookings/business-blocks/${block._id}/activate`, "POST", { property_id: propertyId }),
          book(1, propertyId, type)
        ]);
        assert.equal(results.filter((item) => [200, 201].includes(item.status)).length, 1, JSON.stringify(results));
        assert.equal(results.filter((item) => item.status === 409).length, 1, JSON.stringify(results));
        console.log("PASS: group activation and an individual booking cannot both take the last room.");
      }
      {
        const { propertyId, type } = await fixture();
        const block = await seedBlock(propertyId, type, "active");
        const path = `/bookings/business-blocks/${block._id}/allocations/${block.allocations[0]._id}/reservations`;
        oneWinner(await Promise.all([0, 1].map((index) => request(index, path, "POST", {
          property_id: propertyId, quantity: 1, booker: payload(propertyId, type).booker
        }))));
        assert.equal(await Reservation.countDocuments({ property_id: propertyId }), 1);
        assert.equal(await Invoice.countDocuments({ property_id: propertyId }), 1);
        console.log("PASS: the final group allocation can be picked up only once, with one invoice.");
      }
      {
        const { propertyId, type } = await fixture();
        const plan = await RatePlan.create({ property_id: propertyId, name: "Smoke Room Only", code: "SMOKE", currency: "LKR", meal_plan: "Room Only", cancellation_policy: "Synthetic test policy",
          valid_from: "2026-10-01", valid_to: "2026-11-01", room_type_rates: [{ room_type_id: type._id, amount: 6500 }] });
        const results = await Promise.all([
          book(0, propertyId, type),
          createSimulatedOtaReservation({ property_id: propertyId, provider: "dms-test-channel", external_reservation_id: `TEST-${randomUUID()}`,
            status: "tentative", check_in: "2026-10-20", check_out: "2026-10-22", guest: payload(propertyId, type).booker,
            rooms: [{ rate_plan_id: String(plan._id), room_type_id: String(type._id), adults: 1, children: 0, quantity: 1 }]
          }).then(() => ({ status: 201 }), (error) => ({ status: error.statusCode || 500, message: error.message }))
        ]);
        oneWinner(results);
        assert.equal(await Reservation.countDocuments({ property_id: propertyId }), 1);
        console.log("PASS: manual booking and the test-channel importer share the same protection.");
      }
      {
        const { propertyId, type } = await fixture();
        oneWinner(await workerRace(propertyId, type._id));
        assert.equal(await Reservation.countDocuments({ property_id: propertyId }), 1);
        console.log("PASS: separate Node processes racing the last room produce exactly one booking.");
      }
      {
        const { propertyId } = await fixture();
        await assert.rejects(withInventoryTransaction(propertyId, async () => { throw new Error("synthetic rollback"); }), /synthetic rollback/);
        assert.equal(await withInventoryTransaction(propertyId, async () => "available"), "available");
        console.log("PASS: an aborted transaction does not leave a stuck lock.");
      }
      {
        const { propertyId } = await fixture();
        const created = await request(0, "/rooms", "POST", { property_id: propertyId, name: "Catalog smoke", base_rate: 6500, physical_rooms: [{ room_number: "501" }] });
        assert.equal(created.status, 201, JSON.stringify(created));
        const id = created.body.room_type._id;
        const added = await request(0, `/rooms/${id}/physical-rooms?property_id=${propertyId}`, "POST", { room_number: "502" });
        assert.equal(added.status, 201, JSON.stringify(added));
        const physicalId = added.body.physical_room._id;
        const changed = await request(0, `/rooms/${id}/physical-rooms/${physicalId}?property_id=${propertyId}`, "PATCH", { operational_status: "maintenance" });
        assert.equal(changed.status, 200, JSON.stringify(changed));
        assert.equal(changed.body.physical_room.operational_status, "maintenance");
        const renamed = await request(0, `/rooms/${id}?property_id=${propertyId}`, "PATCH", { name: "Renamed catalog smoke" });
        assert.equal(renamed.status, 200, JSON.stringify(renamed));
        assert.equal((await request(0, `/rooms/${id}/physical-rooms/${physicalId}?property_id=${propertyId}`, "DELETE")).status, 200);
        assert.equal((await request(0, `/rooms/${id}?property_id=${propertyId}`, "DELETE")).status, 200);
        console.log("PASS: guarded room catalog creation, edits, status changes and deletion still work.");
      }
      {
        const first = await fixture();
        const second = await fixture();
        let release;
        let signal;
        const holding = new Promise((resolve) => { release = resolve; });
        const acquired = new Promise((resolve) => { signal = resolve; });
        const pending = withInventoryTransaction(first.propertyId, async () => { signal(); await holding; });
        try {
          await Promise.race([acquired, pending]);
          assert.equal(await withInventoryTransaction(second.propertyId, async () => "independent"), "independent");
        } finally {
          release();
          await pending;
        }
        console.log("PASS: a transaction holding one hotel's guard does not lock another hotel.");
      }
    }

    if (!process.argv.includes("--room-moves-only")) {
    const dayUse = {
      is_day_room: true, check_in: "2026-10-20", check_out: "2026-10-20",
      financial_summary: { room_total: 6500, grand_total: 6500, paid_total: 0 }
    };
    {
      const { propertyId, type } = await fixture();
      const created = await book(0, propertyId, type, dayUse);
      assert.equal(created.status, 201, JSON.stringify(created));
      const saved = created.body.reservation;
      assert.equal(saved.nights, 0);
      assert.equal(saved.check_in.slice(0, 10), "2026-10-20");
      assert.equal(saved.check_out.slice(0, 10), "2026-10-20");
      assert.equal(saved.financial_summary.grand_total, 6500);
      assert.equal((await book(1, propertyId, type, dayUse)).status, 409);
      const edited = await request(0, `/bookings/reservations/${saved._id}`, "PATCH", { property_id: propertyId, ...dayUse });
      assert.equal(edited.status, 200, JSON.stringify(edited));
      await request(0, `/bookings/reservations/${saved._id}/cancel`, "POST", { property_id: propertyId, reason: "Synthetic day-use cancellation" });
      assert.equal((await book(1, propertyId, type, dayUse)).status, 201);
      console.log("PASS DAY USE: zero nights and original dates/price are preserved; duplicate blocked; editing and cancel/retry work.");
    }
    {
      const { propertyId, type } = await fixture();
      assert.equal((await book(0, propertyId, type, dayUse)).status, 201);
      assert.equal((await book(1, propertyId, type, { check_out: "2026-10-21" })).status, 409);
      assert.equal((await book(1, propertyId, type, { check_in: "2026-10-21" })).status, 201);
      console.log("PASS DAY USE: blocks an overnight arrival that day, but not the next day.");
    }
    {
      const { propertyId, type } = await fixture();
      assert.equal((await book(0, propertyId, type, { check_out: "2026-10-21" })).status, 201);
      assert.equal((await book(1, propertyId, type, dayUse)).status, 409);
      assert.equal((await book(1, propertyId, type, { ...dayUse, check_in: "2026-10-21", check_out: "2026-10-21" })).status, 201);
      console.log("PASS DAY USE: respects existing overnight stays and permits their checkout-day turnover.");
    }
    {
      const { propertyId, type } = await fixture();
      await seedBlock(propertyId, type, "active");
      assert.equal((await book(0, propertyId, type, dayUse)).status, 409);
      assert.equal((await book(1, propertyId, type, { ...dayUse, check_in: "2026-10-22", check_out: "2026-10-22" })).status, 201);
      console.log("PASS DAY USE: respects active group holds, including their start/end boundaries.");
    }
    {
      const { propertyId, type } = await fixture(2);
      const assigned = (index) => [{ ...payload(propertyId, type).rooms[0], physical_room_id: type.physical_rooms[index]._id }];
      assert.equal((await book(0, propertyId, type, { ...dayUse, rooms: assigned(0) })).status, 201);
      const conflict = await book(1, propertyId, type, { rooms: assigned(0) });
      assert.equal(conflict.status, 409, JSON.stringify(conflict));
      assert.match(conflict.body.message, /already booked/);
      assert.equal((await book(1, propertyId, type, { ...dayUse, rooms: assigned(1) })).status, 201);
      const linked = await request(0, "/cross-bookings", "POST", { property_id: propertyId, room_a_id: type.physical_rooms[0]._id, room_b_id: type.physical_rooms[1]._id });
      assert.equal(linked.status, 409, JSON.stringify(linked));
      console.log("PASS DAY USE: same physical room is blocked despite spare capacity; conflicting rooms cannot be linked afterward.");
    }
    {
      const { propertyId, type } = await fixture(2);
      const linked = await request(0, "/cross-bookings", "POST", { property_id: propertyId, room_a_id: type.physical_rooms[0]._id, room_b_id: type.physical_rooms[1]._id });
      assert.equal(linked.status, 201, JSON.stringify(linked));
      const assigned = (index) => [{ ...payload(propertyId, type).rooms[0], physical_room_id: type.physical_rooms[index]._id }];
      assert.equal((await book(0, propertyId, type, { ...dayUse, rooms: assigned(0) })).status, 201);
      const conflict = await book(1, propertyId, type, { ...dayUse, rooms: assigned(1) });
      assert.equal(conflict.status, 409, JSON.stringify(conflict));
      assert.match(conflict.body.message, /cross-booked room/);
      console.log("PASS DAY USE: pre-existing cross-booking links block same-day conflicts.");
    }
    {
      const { propertyId, type } = await fixture();
      assert.equal((await book(0, propertyId, type, dayUse)).status, 201);
      const block = await seedBlock(propertyId, type);
      const activated = await request(1, `/bookings/business-blocks/${block._id}/activate`, "POST", { property_id: propertyId });
      assert.equal(activated.status, 409, JSON.stringify(activated));
      console.log("PASS DAY USE: group activation cannot overwrite day-use availability.");
    }
    {
      const { propertyId, type } = await fixture();
      oneWinner(await Promise.all([book(0, propertyId, type, dayUse), book(1, propertyId, type, dayUse)]));
      assert.equal(await Reservation.countDocuments({ property_id: propertyId }), 1);
      console.log("PASS DAY USE: simultaneous same-day requests have exactly one winner.");
    }
    {
      const { propertyId, type } = await fixture();
      oneWinner(await Promise.all([book(0, propertyId, type, dayUse), book(1, propertyId, type)]));
      assert.equal(await Reservation.countDocuments({ property_id: propertyId }), 1);
      console.log("PASS DAY USE: simultaneous day-use versus overnight requests have exactly one winner.");
    }
    {
      const { propertyId, type } = await fixture();
      const confirmed = await saveSeed(propertyId, type, { ...dayUse, status: "confirmed", rooms: [{ ...payload(propertyId, type).rooms[0], physical_room_id: type.physical_rooms[0]._id }] });
      const late = await request(0, `/bookings/reservations/${confirmed._id}/check-in`, "POST", { property_id: propertyId, business_date: "2026-10-21" });
      assert.equal(late.status, 409, JSON.stringify(late));
      const correct = await request(0, `/bookings/reservations/${confirmed._id}/check-in`, "POST", { property_id: propertyId, business_date: "2026-10-20" });
      assert.equal(correct.status, 200, JSON.stringify(correct));
      assert.equal(correct.body.reservation.nights, 0);
      console.log("PASS DAY USE: check-in is allowed on the day-use date, not a later business date.");
    }
    }

    if (!process.argv.includes("--day-use-only")) {
    const inHouse = async (capacity = 3) => {
      const { propertyId, type } = await fixture(capacity);
      type.physical_rooms[0].operational_status = "occupied";
      await type.save();
      const reservation = await saveSeed(propertyId, type, { status: "checked_in", check_in: "2026-10-19", check_out: "2026-10-23",
        rooms: [{ ...payload(propertyId, type).rooms[0], physical_room_id: type.physical_rooms[0]._id, room_number: "101" }],
        financial_summary: { room_total: 26000, grand_total: 26000, paid_total: 5000 } });
      return { propertyId, type, reservation };
    };
    const move = (item, target = 1, overrides = {}, index = 0) => request(index, `/bookings/reservations/${item.reservation._id}/room-moves`, "POST", {
      property_id: item.propertyId, business_date: "2026-10-20", reason: "Synthetic AC repair move",
      moves: [{ room_line_id: item.reservation.rooms[0]._id, from_physical_room_id: item.reservation.rooms[0].physical_room_id, to_physical_room_id: item.type.physical_rooms[target]._id }], ...overrides
    });
    {
      const item = await inHouse();
      await saveSeed(item.propertyId, item.type, { check_in: "2026-10-19", check_out: "2026-10-20", rooms: [{ ...payload(item.propertyId, item.type).rooms[0], physical_room_id: item.type.physical_rooms[1]._id }] });
      const result = await move(item);
      assert.equal(result.status, 200, JSON.stringify(result));
      const saved = result.body.reservation;
      assert.equal(saved.status, "checked_in");
      assert.equal(saved.financial_summary.grand_total, 26000);
      assert.equal(saved.financial_summary.paid_total, 5000);
      assert.equal(saved.rooms[0]._id, String(item.reservation.rooms[0]._id));
      assert.equal(saved.room_moves[0].from_room_number, "101");
      assert.equal(saved.room_moves[0].to_room_number, "102");
      assert.equal(saved.room_moves[0].business_date.slice(0, 10), "2026-10-20");
      assert.equal(saved.room_moves[0].reason, "Synthetic AC repair move");
      const refreshed = await RoomType.findById(item.type._id);
      assert.equal(refreshed.physical_rooms[0].operational_status, "available");
      assert.equal(refreshed.physical_rooms[0].housekeeping_status, "dirty");
      assert.equal(refreshed.physical_rooms[1].operational_status, "occupied");
      assert.equal((await HousekeepingTask.findOne({ property_id: item.propertyId })).status, "assigned");
      assert.equal(await HousekeepingActivity.countDocuments({ property_id: item.propertyId }), 1);
      assert.equal(await BookingAuditLog.countDocuments({ property_id: item.propertyId, action: "reservation_room_moved" }), 1);
      assert.equal((await move(item, 2)).status, 409);
      console.log("PASS ROOM MOVE: remaining-stay move persists both room states/history/cleaning task, preserves charges, and rejects stale requests.");
    }
    {
      const item = await inHouse();
      assert.equal((await move(item)).status, 200);
      const assigned = (index) => [{ ...payload(item.propertyId, item.type).rooms[0], physical_room_id: item.type.physical_rooms[index]._id }];
      assert.equal((await book(0, item.propertyId, item.type, { check_in: "2026-10-19", check_out: "2026-10-20", rooms: assigned(0) })).status, 409);
      assert.equal((await book(0, item.propertyId, item.type, { check_in: "2026-10-19", check_out: "2026-10-20", rooms: assigned(1) })).status, 201);
      assert.equal((await book(0, item.propertyId, item.type, { check_in: "2026-10-20", check_out: "2026-10-21", rooms: assigned(0) })).status, 201);
      const edit = await request(0, `/bookings/reservations/${item.reservation._id}`, "PATCH", { property_id: item.propertyId, guest_remarks: "Preserve moved assignment" });
      assert.equal(edit.status, 200, JSON.stringify(edit));
      assert.equal(edit.body.reservation.room_moves.length, 1);
      const bypass = await request(0, `/bookings/reservations/${item.reservation._id}`, "PATCH", { property_id: item.propertyId, rooms: [item.reservation.rooms[0].toObject()] });
      assert.equal(bypass.status, 409);
      await RoomType.updateOne({ _id: item.type._id }, { $set: { "physical_rooms.0.operational_status": "maintenance" } });
      const checkout = await request(0, `/bookings/reservations/${item.reservation._id}/check-out`, "POST", { property_id: item.propertyId });
      assert.equal(checkout.status, 200, JSON.stringify(checkout));
      const refreshed = await RoomType.findById(item.type._id);
      assert.equal(refreshed.physical_rooms[0].operational_status, "maintenance");
      assert.equal(refreshed.physical_rooms[1].operational_status, "available");
      assert.equal(refreshed.physical_rooms[1].housekeeping_status, "dirty");
      console.log("PASS ROOM MOVE: historical room dates stay correct, normal edits cannot bypass moves, checkout releases only the current room.");
    }
    for (const condition of ["dirty", "maintenance", "out_of_order", "occupied", "inactive"]) {
      const item = await inHouse();
      const to = item.type.physical_rooms[1];
      if (condition === "dirty") to.housekeeping_status = "dirty";
      else if (condition === "inactive") to.active = false;
      else to.operational_status = condition;
      await item.type.save();
      const result = await move(item);
      assert.equal(result.status, 409, JSON.stringify(result));
      const saved = await Reservation.findById(item.reservation._id);
      assert.equal(saved.room_moves.length, 0);
      assert.equal(String(saved.rooms[0].physical_room_id), String(item.type.physical_rooms[0]._id));
      assert.equal(await HousekeepingTask.countDocuments({ property_id: item.propertyId }), 0);
      console.log(`PASS ROOM MOVE: ${condition} destination rejected without changing the original reservation.`);
    }
    {
      const item = await inHouse();
      await saveSeed(item.propertyId, item.type, { check_in: "2026-10-21", check_out: "2026-10-23", rooms: [{ ...payload(item.propertyId, item.type).rooms[0], physical_room_id: item.type.physical_rooms[1]._id }] });
      const result = await move(item);
      assert.equal(result.status, 409, JSON.stringify(result));
      console.log("PASS ROOM MOVE: a future conflict during the remaining stay blocks the move.");
    }
    {
      const item = await inHouse();
      const alternate = await RoomType.create({ property_id: item.propertyId, name: "Other type", base_rate: 10000, physical_rooms: [{ room_number: "201" }] });
      const result = await move(item, 1, { moves: [{ room_line_id: item.reservation.rooms[0]._id, from_physical_room_id: item.type.physical_rooms[0]._id, to_physical_room_id: alternate.physical_rooms[0]._id }] });
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.equal((await move(item, 1, { business_date: "2026-10-23" })).status, 409);
      item.reservation.status = "confirmed"; await item.reservation.save();
      assert.equal((await move(item)).status, 409);
      console.log("PASS ROOM MOVE: unsupported room-type changes, invalid move dates and non-checked-in guests are rejected.");
    }
    {
      const item = await inHouse();
      item.type.physical_rooms[1].operational_status = "occupied"; await item.type.save();
      const other = await saveSeed(item.propertyId, item.type, { status: "checked_in", check_in: "2026-10-19", check_out: "2026-10-23", rooms: [{ ...payload(item.propertyId, item.type).rooms[0], physical_room_id: item.type.physical_rooms[1]._id, room_number: "102" }] });
      const second = { ...item, reservation: other };
      oneWinner(await Promise.all([move(item, 2), move(second, 2, {}, 1)]), 200);
      assert.equal(await BookingAuditLog.countDocuments({ property_id: item.propertyId, action: "reservation_room_moved" }), 1);
      console.log("PASS ROOM MOVE: concurrent moves competing for the same destination have one winner.");
    }
    {
      const item = await inHouse();
      const original = BookingAuditLog.create;
      let result;
      try {
        BookingAuditLog.create = async () => { throw Object.assign(new Error("Synthetic rollback test"), { statusCode: 503 }); };
        result = await move(item);
      } finally { BookingAuditLog.create = original; }
      assert.equal(result.status, 503, JSON.stringify(result));
      const saved = await Reservation.findById(item.reservation._id);
      assert.equal(saved.room_moves.length, 0);
      assert.equal(await HousekeepingTask.countDocuments({ property_id: item.propertyId }), 0);
      assert.equal(await HousekeepingActivity.countDocuments({ property_id: item.propertyId }), 0);
      const refreshed = await RoomType.findById(item.type._id);
      assert.equal(refreshed.physical_rooms[0].operational_status, "occupied");
      assert.equal(refreshed.physical_rooms[1].operational_status, "available");
      assert.equal((await move(item)).status, 200);
      console.log("PASS ROOM MOVE: injected mid-transaction failure rolls back room states, history and cleaning records; retry succeeds.");
    }
    {
      const item = await inHouse(4);
      item.type.physical_rooms[1].operational_status = "occupied"; await item.type.save();
      item.reservation.rooms.push({ ...payload(item.propertyId, item.type).rooms[0], physical_room_id: item.type.physical_rooms[1]._id, room_number: "102" });
      await item.reservation.save();
      const moves = item.reservation.rooms.map((line, index) => ({ room_line_id: line._id, from_physical_room_id: line.physical_room_id, to_physical_room_id: item.type.physical_rooms[index + 2]._id }));
      item.type.physical_rooms[3].housekeeping_status = "dirty"; await item.type.save();
      assert.equal((await move(item, 2, { moves })).status, 409);
      assert.equal((await Reservation.findById(item.reservation._id)).room_moves.length, 0);
      assert.equal(await HousekeepingTask.countDocuments({ property_id: item.propertyId }), 0);
      item.type.physical_rooms[3].housekeeping_status = "inspected"; await item.type.save();
      const result = await move(item, 2, { moves });
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.body.reservation.room_moves.length, 2);
      assert.equal(result.body.reservation.rooms.length, 2);
      const refreshed = await RoomType.findById(item.type._id);
      assert.equal(refreshed.physical_rooms[0].housekeeping_status, "dirty");
      assert.equal(refreshed.physical_rooms[1].housekeeping_status, "dirty");
      assert.equal(refreshed.physical_rooms[2].operational_status, "occupied");
      assert.equal(refreshed.physical_rooms[3].operational_status, "occupied");
      console.log("PASS ROOM MOVE: multi-room batch is atomic; a dirty second target blocks all moves and inspected targets are accepted.");
    }
    {
      const item = await inHouse();
      item.reservation.check_in = new Date("2026-10-20"); item.reservation.check_out = new Date("2026-10-20"); item.reservation.is_day_room = true;
      await item.reservation.save();
      const result = await move(item);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.body.reservation.nights, 0);
      assert.equal(result.body.reservation.check_out.slice(0, 10), "2026-10-20");
      console.log("PASS ROOM MOVE: day-use room moves preserve same-day dates and zero overnight nights.");
    }
    {
      const item = await inHouse();
      await CrossBooking.create({ property_id: item.propertyId, room_a_id: item.type.physical_rooms[1]._id, room_b_id: item.type.physical_rooms[2]._id,
        room_a_number: "102", room_b_number: "103", room_a_type_id: item.type._id, room_b_type_id: item.type._id, room_a_type_name: item.type.name, room_b_type_name: item.type.name });
      await saveSeed(item.propertyId, item.type, { is_day_room: true, check_in: "2026-10-21", check_out: "2026-10-21", rooms: [{ ...payload(item.propertyId, item.type).rooms[0], physical_room_id: item.type.physical_rooms[2]._id, room_number: "103" }] });
      const result = await move(item);
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.match(result.body.message, /cross-booked room/);
      console.log("PASS ROOM MOVE: cross-linked day-use conflicts during the remaining stay block moves.");
    }
    {
      const item = await inHouse(2);
      const results = await Promise.all([move(item), book(1, item.propertyId, item.type, {
        check_in: "2026-10-20", check_out: "2026-10-23", rooms: [{ ...payload(item.propertyId, item.type).rooms[0], physical_room_id: item.type.physical_rooms[1]._id }]
      })]);
      assert.equal(results.filter((result) => [200, 201].includes(result.status)).length, 1, JSON.stringify(results));
      assert.equal(results.filter((result) => result.status === 409).length, 1, JSON.stringify(results));
      console.log("PASS ROOM MOVE: a move and a new booking competing for the destination have exactly one winner.");
    }
    }
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    try {
      if (mongoose.connection.readyState === 1 && properties.length) {
        assert.ok(properties.every((id) => id.startsWith(`${namespace}-`) && /^\d+$/.test(id.slice(namespace.length + 1))));
        for (const Model of [Reservation, BusinessBlock, CrossBooking, Guest, Invoice, BookingAuditLog, DocumentCounter, FinancialTransaction, RatePlan, DailyRate, RoomType, HousekeepingTask, HousekeepingActivity]) {
          const filter = { property_id: { $in: properties } };
          await Model.deleteMany(filter);
          assert.equal(await Model.countDocuments(filter), 0);
        }
        await InventoryGuard.deleteMany({ _id: { $in: properties } });
        assert.equal(await InventoryGuard.countDocuments({ _id: { $in: properties } }), 0);
        console.log("Cleanup verified: only this run's temporary test namespaces were removed.");
      }
    } finally {
      await disconnectDatabase();
    }
  }
}

if (process.env.NODE_ENV === "production") {
  console.error("Concurrency smoke tests are disabled in production.");
  process.exitCode = 1;
} else {
  (process.argv.includes("--worker") ? worker() : main()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
