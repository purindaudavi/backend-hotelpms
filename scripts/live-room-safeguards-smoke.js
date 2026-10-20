require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");
const mongoose = require("mongoose");
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
const { connectDatabase, disconnectDatabase } = require("../config/database");
const RoomType = require("../db_models/rooms.model");
const Property = require("../db_models/property.model");
const Reservation = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");
const CrossBooking = require("../db_models/crossbooking.model");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const { HousekeepingTask, HousekeepingActivity } = require("../db_models/housecleaning.model");
const InventoryGuard = require("../db_models/inventory-guard.model");
const Guest = require("../db_models/guest.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const DocumentCounter = require("../db_models/document-counter.model");

async function main() {
  if (!process.argv.includes("--run") || process.env.NODE_ENV === "production") throw new Error("Use --run only with the development/test database, never production.");
  const namespace = `room-safety-${randomUUID()}`;
  const properties = [];
  const servers = [];
  console.log(`Temporary test namespace: ${namespace}`);
  try {
    await connectDatabase();
    for (let index = 0; index < 2; index++) {
      const app = express(); app.use(express.json());
      app.use((req, res, next) => properties.includes(req.query.property_id || req.body?.property_id)
        ? next() : res.status(403).json({ message: "Only this run's temporary properties are accepted." }));
      app.use("/rooms", require("../routes/rooms"));
      app.use("/bookings", require("../routes/bookings"));
      const server = app.listen(0, "127.0.0.1"); servers.push(server);
      await new Promise((resolve) => server.once("listening", resolve));
    }
    const request = async (propertyId, path, method, body, server = 0) => {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`http://127.0.0.1:${servers[server].address().port}${path}${separator}property_id=${propertyId}`, {
        method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    const fixture = async (capacity = 2) => {
      const propertyId = `${namespace}-${properties.length + 1}`; properties.push(propertyId);
      await Property.create({ property_id: propertyId, business_date: "2026-10-20", info: {
        hotel_name: "Synthetic room safety test", address: "Test only", country_code: "LK", email: "test@example.com"
      } });
      const type = await RoomType.create({ property_id: propertyId, name: "Safety Standard", base_rate: 6500,
        physical_rooms: Array.from({ length: capacity }, (_, index) => ({ room_number: String(101 + index) })) });
      return { propertyId, type };
    };
    const data = (item, overrides = {}) => ({ property_id: item.propertyId, reservation_no: `SAFE-${randomUUID()}`, status: "confirmed",
      check_in: "2026-10-21", check_out: "2026-10-23", booking_source: "Direct", currency: "LKR",
      booker: { name: "Synthetic room safety guest", phone: "+94710000000", email: `${randomUUID()}@example.com`, country: "Sri Lanka" },
      rooms: [{ room_type_id: item.type._id, room_type_name: item.type.name, physical_room_id: item.type.physical_rooms[0]._id,
        room_number: "101", adults: 1, children: 0, original_nightly_rate: 6500, effective_nightly_rate: 6500 }], ...overrides });
    const physicalPath = (item, index = 0) => `/rooms/${item.type._id}/physical-rooms/${item.type.physical_rooms[index]._id}`;
    const edit = (item, body, index = 0, server = 0) => request(item.propertyId, physicalPath(item, index), "PATCH", body, server);
    const verify409 = (result, pattern) => { assert.equal(result.status, 409, JSON.stringify(result)); if (pattern) assert.match(result.body.message, pattern); };

    {
      const item = await fixture();
      item.type.physical_rooms[0].operational_status = "occupied"; await item.type.save();
      for (const status of ["available", "maintenance", "out_of_order"]) verify409(await edit(item, { operational_status: status }), /Check out or move/);
      verify409(await edit(item, { active: false }));
      verify409(await request(item.propertyId, `${physicalPath(item)}?force=true`, "DELETE"));
      verify409(await request(item.propertyId, `/rooms/${item.type._id}?force=true`, "DELETE"));
      verify409(await request(item.propertyId, `/rooms/${item.type._id}`, "PATCH", { active: false }));
      assert.equal((await edit(item, { notes: "Towels requested" })).status, 200);
      const saved = await RoomType.findById(item.type._id);
      assert.equal(saved.physical_rooms[0].operational_status, "occupied"); assert.equal(saved.active, true);
      console.log("PASS: occupied status, disable and delete guards cannot be bypassed with force; harmless notes still save.");
    }
    {
      const item = await fixture();
      verify409(await edit(item, { operational_status: "occupied" }), /check-in/);
      verify409(await request(item.propertyId, `/rooms/${item.type._id}/physical-rooms`, "POST", { room_number: "999", operational_status: "occupied" }));
      verify409(await request(item.propertyId, "/rooms", "POST", { name: "Fake occupied", base_rate: 6500, physical_rooms: [{ room_number: "888", operational_status: "occupied" }] }));
      assert.equal(await RoomType.countDocuments({ property_id: item.propertyId }), 1);
      assert.equal((await RoomType.findById(item.type._id)).physical_rooms.length, 2);
      console.log("PASS: manual room/type creation cannot invent occupied rooms; rejected requests leave no records.");
    }
    for (const status of ["confirmed", "tentative", "blocked"]) {
      const item = await fixture(3); await Reservation.create(data(item, { status }));
      for (const operational_status of ["maintenance", "out_of_order"]) verify409(await edit(item, { operational_status }), /assigned to/);
      verify409(await edit(item, { active: false }));
      verify409(await request(item.propertyId, `/rooms/${item.type._id}`, "PATCH", { active: false }));
      verify409(await request(item.propertyId, `${physicalPath(item)}?force=true`, "DELETE"));
      console.log(`PASS: ${status} future reservations protect their assigned room and type, even with spare capacity.`);
    }
    {
      const item = await fixture();
      const record = await Reservation.create(data(item, { status: "checked_in", check_in: "2026-10-19", check_out: "2026-10-20" }));
      verify409(await edit(item, { operational_status: "maintenance" }), /checked-in reservation/);
      verify409(await request(item.propertyId, `/rooms/${item.type._id}`, "PATCH", { active: false }));
      assert.equal(record.status, "checked_in");
      console.log("PASS: persisted in-house reservation wins over a stale available flag, even on/after departure day.");
    }
    {
      const item = await fixture();
      const record = await Reservation.create(data(item, { rooms: Array.from({ length: 2 }, () => ({ room_type_id: item.type._id, room_type_name: item.type.name })) }));
      verify409(await edit(item, { operational_status: "maintenance" }), /2 are needed on 2026-10-21/);
      record.status = "cancelled"; await record.save();
      assert.equal((await edit(item, { operational_status: "maintenance" })).status, 200);
      console.log("PASS: unassigned future bookings protect type capacity; cancellation permits taking the room offline.");
    }
    {
      const item = await fixture(1);
      await Reservation.create(data(item, { is_day_room: true, check_in: "2026-10-20", check_out: "2026-10-20",
        rooms: [{ room_type_id: item.type._id, room_type_name: item.type.name }] }));
      verify409(await edit(item, { operational_status: "maintenance" }), /needed on 2026-10-20/);
      console.log("PASS: zero-night day-use reservations protect their arrival-date capacity.");
    }
    {
      const item = await fixture();
      const group = await BusinessBlock.create({ property_id: item.propertyId, block_number: `SAFE-${randomUUID()}`, block_name: "Safety group", company_name: "Synthetic",
        check_in: "2026-10-21", check_out: "2026-10-23", cutoff_date: "2026-10-20", status: "active",
        allocations: [{ room_type_id: item.type._id, room_type_name: item.type.name, quantity: 2, negotiated_rate: 6500 }] });
      verify409(await edit(item, { operational_status: "out_of_order" }), /2 are needed/);
      group.allocations[0].released_quantity = 1; await group.save();
      assert.equal((await edit(item, { operational_status: "out_of_order" })).status, 200);
      console.log("PASS: unpicked group holds protect capacity; releasing enough stock permits the change.");
    }
    {
      const item = await fixture(1); await Reservation.create(data(item, { status: "checked_out", check_in: "2026-10-18", check_out: "2026-10-19" }));
      verify409(await request(item.propertyId, physicalPath(item), "DELETE"), /history/);
      verify409(await edit(item, { room_number: "999" }), /history/);
      assert.equal((await edit(item, { active: false })).status, 200);
      assert.equal((await request(item.propertyId, `/rooms/${item.type._id}`, "PATCH", { active: false })).status, 200);
      verify409(await request(item.propertyId, `/rooms/${item.type._id}?force=true`, "DELETE"), /history/);
      console.log("PASS: past stays retain room/type identities; safe disabling is allowed instead of hard deletion.");
    }
    {
      const item = await fixture();
      await CrossBooking.create({ property_id: item.propertyId, room_a_id: item.type.physical_rooms[0]._id, room_b_id: item.type.physical_rooms[1]._id,
        room_a_number: "101", room_b_number: "102", room_a_type_id: item.type._id, room_b_type_id: item.type._id, room_a_type_name: item.type.name, room_b_type_name: item.type.name });
      verify409(await request(item.propertyId, physicalPath(item), "DELETE"), /cross-booking/);
      console.log("PASS: cross-booking links cannot be orphaned by room deletion.");
    }
    {
      const item = await fixture(); await HousekeepingTask.create({ property_id: item.propertyId, physical_room_id: item.type.physical_rooms[0]._id,
        room_type_id: item.type._id, room_number: "101", room_type_name: item.type.name });
      verify409(await request(item.propertyId, physicalPath(item), "DELETE"), /housekeeping history/);
      console.log("PASS: housekeeping history prevents destructive room deletion.");
    }
    {
      const item = await fixture(); await RatePlan.create({ property_id: item.propertyId, name: "Safety room only", code: "SAFE", valid_from: "2026-10-01", valid_to: "2026-12-31", cancellation_policy: "Synthetic test policy",
        room_type_rates: [{ room_type_id: item.type._id, amount: 6500 }] });
      verify409(await request(item.propertyId, `/rooms/${item.type._id}`, "DELETE"), /saved rates/);
      console.log("PASS: saved rate references protect room-type identity.");
    }
    {
      const item = await fixture();
      assert.equal((await edit(item, { operational_status: "maintenance" })).status, 200);
      verify409(await request(item.propertyId, "/bookings/reservations", "POST", data(item)), /Select another room/);
      assert.equal((await edit(item, { operational_status: "available" })).status, 200);
      assert.equal((await request(item.propertyId, physicalPath(item), "DELETE")).status, 200);
      assert.equal((await request(item.propertyId, `/rooms/${item.type._id}`, "DELETE")).status, 200);
      console.log("PASS: unreferenced empty rooms can still change status, return to service and be deleted.");
    }
    for (const assigned of [true, false]) {
      const item = await fixture(1);
      const body = data(item);
      if (!assigned) delete body.rooms[0].physical_room_id;
      const results = await Promise.all([
        request(item.propertyId, "/bookings/reservations", "POST", body, 0),
        edit(item, { operational_status: "maintenance" }, 0, 1)
      ]);
      assert.equal(results.filter((result) => [200, 201].includes(result.status)).length, 1, JSON.stringify(results));
      assert.equal(results.filter((result) => result.status === 409).length, 1, JSON.stringify(results));
      const type = await RoomType.findById(item.type._id); const count = await Reservation.countDocuments({ property_id: item.propertyId });
      assert.ok(type.physical_rooms[0].operational_status === "maintenance" ? count === 0 : count === 1);
      console.log(`PASS: ${assigned ? "assigned" : "unassigned"} booking vs maintenance race has exactly one winner, no stranded reservation.`);
    }
    console.log("All 16 room-safety scenarios passed.");
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    try {
      if (mongoose.connection.readyState === 1 && properties.length) {
        assert.ok(properties.every((id) => id.startsWith(`${namespace}-`) && /^\d+$/.test(id.slice(namespace.length + 1))));
        for (const Model of [Reservation, BusinessBlock, CrossBooking, RatePlan, DailyRate, HousekeepingTask, HousekeepingActivity, RoomType, Property, Guest, BookingAuditLog, DocumentCounter]) {
          const filter = { property_id: { $in: properties } }; await Model.deleteMany(filter); assert.equal(await Model.countDocuments(filter), 0);
        }
        await InventoryGuard.deleteMany({ _id: { $in: properties } });
        assert.equal(await InventoryGuard.countDocuments({ _id: { $in: properties } }), 0);
        console.log("Cleanup verified: only this run's temporary namespaces were removed.");
      }
    } finally { await disconnectDatabase(); }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
