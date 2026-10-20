const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const Property = require("../db_models/property.model");
const { physicalAssignments } = require("../services/booking-inventory-dates.service");
const { preserveAssignmentMetadata, moveInHouseRooms } = require("../services/room-move.service");

function fixture() {
  return new Reservation({ property_id: "move-test", reservation_no: "MOVE-1", status: "checked_in", check_in: "2026-10-19", check_out: "2026-10-23",
    booker: { name: "Test Guest", phone: "+94710000000", email: "test@example.com", country: "Sri Lanka" },
    rooms: [{ room_type_id: new mongoose.Types.ObjectId(), room_type_name: "Standard", physical_room_id: new mongoose.Types.ObjectId(), room_number: "101" }] });
}

test("a room move requires a live transaction", async () => {
  await assert.rejects(moveInHouseRooms({ reservation: fixture() }), { statusCode: 500 });
});

test("a room move rejects non-in-house status before any database access", async () => {
  const reservation = fixture(); reservation.status = "confirmed";
  await assert.rejects(moveInHouseRooms({ reservation, session: { inTransaction: () => true } }), /Only a checked-in/);
});

test("empty move requests and missing reasons fail validation", async () => {
  const reservation = fixture(); const session = { inTransaction: () => true };
  await assert.rejects(moveInHouseRooms({ reservation, session, moves: [] }), { statusCode: 400 });
  await assert.rejects(moveInHouseRooms({ reservation, session, moves: [{}], reason: " " }), /move reason/);
});

test("a general edit preserves server-owned assignment dates", () => {
  const record = fixture(); record.rooms[0].current_assignment_from = new Date("2026-10-20");
  const before = record.toObject();
  record.rooms[0].current_assignment_from = new Date("2026-10-22");
  preserveAssignmentMetadata(before, record);
  assert.equal(record.rooms[0].current_assignment_from.toISOString().slice(0, 10), "2026-10-20");
});

test("a general edit cannot switch an in-house physical room or drop room lines", () => {
  const record = fixture(); const before = record.toObject();
  record.rooms[0].physical_room_id = new mongoose.Types.ObjectId();
  assert.throws(() => preserveAssignmentMetadata(before, record), /Use Move room/);
  record.rooms = [];
  assert.throws(() => preserveAssignmentMetadata(before, record), /Use Move room/);
});

test("a general edit cannot rewrite the arrival or day-room flag after check-in", () => {
  const record = fixture(); const before = record.toObject();
  record.check_in = new Date("2026-10-20");
  assert.throws(() => preserveAssignmentMetadata(before, record), /arrival date/);
});

test("room-move history splits assignment dates without rewriting the stay", async () => {
  const record = fixture(); const room = record.rooms[0]; const oldId = room.physical_room_id;
  room.physical_room_id = new mongoose.Types.ObjectId(); room.room_number = "102"; room.current_assignment_from = new Date("2026-10-20");
  record.room_moves.push({ room_line_id: room._id, room_type_id: room.room_type_id, room_type_name: "Standard",
    from_physical_room_id: oldId, from_room_number: "101", to_physical_room_id: room.physical_room_id, to_room_number: "102",
    previous_assigned_from: record.check_in, business_date: "2026-10-20", actor: { name: "Front Desk" }, reason: "AC repair" });
  await record.validate();
  const assignments = physicalAssignments(record);
  assert.equal(assignments.find((item) => item.room_number === "101").end, Date.parse("2026-10-20"));
  assert.equal(assignments.find((item) => item.room_number === "102").start, Date.parse("2026-10-20"));
  assert.equal(record.nights, 4);
  assert.equal(record.check_in.toISOString().slice(0, 10), "2026-10-19");
});

test("same-day repeated room moves keep logs but do not invent extra date inventory", () => {
  const record = fixture(); const room = record.rooms[0];
  room.current_assignment_from = new Date("2026-10-20");
  record.room_moves.push({ room_line_id: room._id, room_type_id: room.room_type_id, room_type_name: "Standard", from_physical_room_id: new mongoose.Types.ObjectId(),
    from_room_number: "100", to_physical_room_id: room.physical_room_id, to_room_number: "101", previous_assigned_from: "2026-10-20", business_date: "2026-10-20", reason: "Same-day move" });
  assert.equal(physicalAssignments(record).length, 1);
  assert.equal(record.room_moves.length, 1);
});

test("the property's saved business date overrides stale client move dates", async (t) => {
  t.mock.method(Property, "findOne", () => ({ session: async () => ({ business_date: new Date("2026-10-21") }) }));
  await assert.rejects(moveInHouseRooms({ reservation: fixture(), moves: [{}], reason: "Repair", businessDate: "2026-10-20", session: { inTransaction: () => true } }), /business date changed/);
});

test("a moved stay cannot be shortened to before its current room allocation", () => {
  const record = fixture(); record.rooms[0].current_assignment_from = new Date("2026-10-21");
  const before = record.toObject(); record.check_out = new Date("2026-10-21");
  assert.throws(() => preserveAssignmentMetadata(before, record), /Check-out cannot be before/);
});
