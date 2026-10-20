require("dotenv").config({ quiet: true });

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
// This smoke test uses existing collections; it must not build indexes.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
const { connectDatabase, disconnectDatabase } = require("../config/database");
const RoomType = require("../db_models/rooms.model");
const Reservation = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");
const { validateReservationInventory } = require("../services/booking-availability.service");

const propertyId = `nightly-inventory-smoke-${randomUUID()}`;
const createdIds = new Map([[RoomType, []], [Reservation, []], [BusinessBlock, []]]);

async function saveFixture(document) {
  assert.equal(document.property_id, propertyId);
  // Remember IDs before writing, including if a write later times out.
  createdIds.get(document.constructor).push(document._id);
  return document.save();
}

async function main() {
  if (!process.argv.includes("--run") || process.env.NODE_ENV === "production") {
    throw new Error("Run explicitly with --run against a development/test database, never production.");
  }
  console.log(`Temporary test namespace: ${propertyId}`);
  try {
    await connectDatabase();
    const type = await saveFixture(new RoomType({
      property_id: propertyId, name: "Nightly Smoke Standard", base_rate: 6500,
      physical_rooms: [{ room_number: "101" }, { room_number: "102" }]
    }));
    const room = (physicalRoom = type.physical_rooms[1]) => ({
      room_type_id: type._id, room_type_name: type.name,
      physical_room_id: physicalRoom._id, adults: 1, children: 0,
      original_nightly_rate: 6500, effective_nightly_rate: 6500
    });
    const reservation = (number, from, to, physicalRoom) => new Reservation({
      property_id: propertyId, reservation_no: `NIGHTLY-SMOKE-${number}`,
      check_in: from, check_out: to, status: "confirmed",
      booker: { name: "Synthetic inventory guest", phone: "+94710000000", email: "inventory-smoke@example.com", country: "Sri Lanka" },
      rooms: [room(physicalRoom)]
    });
    const validate = (overrides = {}) => validateReservationInventory({
      propertyId, checkIn: new Date("2026-10-20"), checkOut: new Date("2026-10-22"),
      rooms: [room()], ...overrides
    });

    await saveFixture(reservation("A", "2026-10-20", "2026-10-21", type.physical_rooms[0]));
    await saveFixture(reservation("B", "2026-10-21", "2026-10-22", type.physical_rooms[0]));
    await validate();
    console.log("PASS: room 102 accepts the two-night stay despite consecutive bookings in room 101.");
    await assert.rejects(validate({ rooms: [room(type.physical_rooms[0])] }), /already booked/);
    console.log("PASS: overlapping assignment of room 101 is still rejected.");

    const third = await saveFixture(reservation("C", "2026-10-20", "2026-10-22", type.physical_rooms[1]));
    await assert.rejects(validate({ rooms: [{ room_type_id: type._id, adults: 1, children: 0 }] }), /0 sellable.*2026-10-20/);
    console.log("PASS: an extra booking is rejected once both rooms are full, with the date.");
    await validate({ excludeReservationId: third._id });
    console.log("PASS: editing a reservation does not count itself twice.");
    await validate({ checkIn: new Date("2026-10-22"), checkOut: new Date("2026-10-23") });
    console.log("PASS: checkout releases inventory for the next arrival date.");

    for (const [index, from, to] of [[1, "2026-10-24", "2026-10-25"], [2, "2026-10-25", "2026-10-26"]]) {
      await saveFixture(new BusinessBlock({
        property_id: propertyId, block_number: `NIGHTLY-SMOKE-BB-${index}`,
        block_name: "Synthetic nightly hold", company_name: "Inventory smoke test",
        check_in: from, check_out: to, cutoff_date: "2026-10-23", status: "active",
        allocations: [{ room_type_id: type._id, room_type_name: type.name, quantity: 1 }]
      }));
    }
    await validate({ checkIn: new Date("2026-10-24"), checkOut: new Date("2026-10-26") });
    console.log("PASS: consecutive one-night group holds leave one room free each night.");
    await assert.rejects(validate({
      checkIn: new Date("2026-10-24"), checkOut: new Date("2026-10-26"),
      rooms: [room(), room(type.physical_rooms[0])]
    }), /1 sellable.*2026-10-24/);
    console.log("PASS: group holds still prevent selling more than nightly capacity.");
  } finally {
    try {
      if (mongoose.connection.readyState === 1) {
        assert.match(propertyId, /^nightly-inventory-smoke-[0-9a-f-]{36}$/);
        for (const Model of [Reservation, BusinessBlock, RoomType]) {
          const filter = { property_id: propertyId, _id: { $in: createdIds.get(Model) } };
          await Model.deleteMany(filter);
          assert.equal(await Model.countDocuments(filter), 0);
        }
        console.log("Cleanup verified: only this run's temporary fixtures were removed.");
      }
    } finally {
      await disconnectDatabase();
    }
  }
}

main().catch((error) => {
  console.error(`Nightly inventory smoke test failed (${error.name}). Inspect the test database and rerun; namespace: ${propertyId}`);
  process.exitCode = 1;
});
