const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");

function validReservation(overrides = {}) {
  return new Reservation({
    property_id: "demo",
    reservation_no: "res-test-001",
    booking_reference: "WEB-1001",
    reservation_date: "2026-07-30",
    check_in: "2026-08-01",
    check_out: "2026-08-03",
    status: "confirmed",
    booking_source: "Direct",
    booker: {
      name: "  Nimal   Perera ",
      phone: "+94 71 222 1188",
      email: " NIMAL@EXAMPLE.COM ",
      country: " Sri Lanka "
    },
    rooms: [
      {
        room_type_id: new mongoose.Types.ObjectId(),
        room_type_name: "Deluxe Double Room",
        adults: 2,
        children: 0,
        currency: "LKR",
        effective_nightly_rate: 14500
      }
    ],
    currency: "lkr",
    financial_summary: {
      room_total: 29000,
      grand_total: 29000,
      paid_total: 5000
    },
    ...overrides
  });
}

function validBusinessBlock(overrides = {}) {
  return new BusinessBlock({
    property_id: "demo",
    block_number: "bb-test-001",
    block_name: "Blue Ocean Crew",
    company_name: "Blue Ocean Tours",
    contact: {
      name: "John Silva",
      email: "john@example.com",
      phone: "+94 77 123 4567"
    },
    check_in: "2026-08-10",
    check_out: "2026-08-13",
    cutoff_date: "2026-08-05",
    allocations: [
      {
        room_type_id: new mongoose.Types.ObjectId(),
        room_type_name: "Deluxe Double Room",
        quantity: 4,
        currency: "LKR",
        negotiated_rate: 12000
      }
    ],
    ...overrides
  });
}

test("validates, normalizes, and calculates reservation summary values", async () => {
  const reservation = validReservation();
  await reservation.validate();

  assert.equal(reservation.reservation_no, "RES-TEST-001");
  assert.equal(reservation.booker.name, "Nimal Perera");
  assert.equal(reservation.booker.email, "nimal@example.com");
  assert.equal(reservation.currency, "LKR");
  assert.equal(reservation.room_count, 1);
  assert.equal(reservation.nights, 2);
  assert.equal(reservation.balance, 24000);
});

test("rejects an invalid reservation stay range", async () => {
  const reservation = validReservation({
    check_in: "2026-08-03",
    check_out: "2026-08-03"
  });
  await assert.rejects(reservation.validate(), /Check-out must be after check-in/);
});

test("stores a meal allocation snapshot on a reservation room", async () => {
  const allocationId = new mongoose.Types.ObjectId();
  const reservation = validReservation();
  reservation.rooms[0].meal_plan = "Bed & Breakfast";
  reservation.rooms[0].meal_allocation_snapshot = {
    meal_allocation_id: allocationId,
    name: "Standard breakfast allocation",
    meal_plan: "Bed & Breakfast",
    currency: "LKR",
    adult_amounts: { breakfast: 2000, lunch: 0, dinner: 0 },
    child_amounts: { breakfast: 1000, lunch: 0, dinner: 0 },
    valid_from: "2026-08-01",
    valid_to: "2026-08-31"
  };

  await reservation.validate();
  assert.equal(reservation.rooms[0].meal_allocation_snapshot.name, "Standard breakfast allocation");
  assert.equal(reservation.rooms[0].meal_allocation_snapshot.adult_amounts.breakfast, 2000);
});

test("rejects duplicate primary occupants for one reservation room", async () => {
  const reservation = validReservation();
  const roomLineId = reservation.rooms[0]._id;
  reservation.occupants = [
    {
      room_line_id: roomLineId,
      name: "Guest One",
      guest_type: "adult",
      is_primary: true
    },
    {
      room_line_id: roomLineId,
      name: "Guest Two",
      guest_type: "adult",
      is_primary: true
    }
  ];

  await assert.rejects(
    reservation.validate(),
    /Only one primary occupant is allowed per room/
  );
});

test("validates a business block and calculates nights", async () => {
  const block = validBusinessBlock();
  await block.validate();

  assert.equal(block.block_number, "BB-TEST-001");
  assert.equal(block.nights, 3);
  assert.equal(block.allocations.length, 1);
});

test("rejects duplicate room-type allocations", async () => {
  const roomTypeId = new mongoose.Types.ObjectId();
  const allocation = {
    room_type_id: roomTypeId,
    room_type_name: "Deluxe Double Room",
    quantity: 2,
    currency: "LKR",
    negotiated_rate: 12000
  };
  const block = validBusinessBlock({
    allocations: [allocation, { ...allocation }]
  });

  await assert.rejects(
    block.validate(),
    /A room type can appear only once in a business block/
  );
});

test("rejects a cut-off date after block check-in", async () => {
  const block = validBusinessBlock({ cutoff_date: "2026-08-11" });
  await assert.rejects(
    block.validate(),
    /Cut-off date cannot be after check-in/
  );
});
