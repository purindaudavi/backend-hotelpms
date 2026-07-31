const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const CrossBooking = require("../db_models/crossbooking.model");

function validCrossBooking(overrides = {}) {
  return new CrossBooking({
    property_id: "demo",
    room_a_id: new mongoose.Types.ObjectId("000000000000000000000002"),
    room_b_id: new mongoose.Types.ObjectId("000000000000000000000001"),
    room_a_number: "02",
    room_b_number: "01",
    room_a_type_id: new mongoose.Types.ObjectId(),
    room_b_type_id: new mongoose.Types.ObjectId(),
    room_a_type_name: "Deluxe Double",
    room_b_type_name: "Family Suite",
    ...overrides
  });
}

test("normalizes a cross-booking pair into stable room ID order", async () => {
  const link = validCrossBooking();
  await link.validate();

  assert.equal(String(link.room_a_id), "000000000000000000000001");
  assert.equal(String(link.room_b_id), "000000000000000000000002");
  assert.equal(link.room_a_number, "01");
  assert.equal(link.room_b_number, "02");
  assert.equal(link.room_a_type_name, "Family Suite");
  assert.equal(link.room_b_type_name, "Deluxe Double");
});

test("rejects a room linked to itself", async () => {
  const roomId = new mongoose.Types.ObjectId();
  const link = validCrossBooking({ room_a_id: roomId, room_b_id: roomId });

  await assert.rejects(
    link.validate(),
    /A room cannot be cross-booked with itself/
  );
});

test("requires property, room IDs, room numbers and room types", async () => {
  const link = validCrossBooking({
    property_id: "",
    room_a_id: null,
    room_b_id: null,
    room_a_number: "",
    room_b_number: "",
    room_a_type_id: null,
    room_b_type_id: null,
    room_a_type_name: "",
    room_b_type_name: ""
  });

  await assert.rejects(
    link.validate(),
    /Property ID is required|physical room ID is required|room number is required|room type ID is required|room type name is required/
  );
});
