const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const RoomType = require("../db_models/rooms.model");
const Reservation = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");
const Property = require("../db_models/property.model");
const CrossBooking = require("../db_models/crossbooking.model");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const { HousekeepingTask, HousekeepingActivity } = require("../db_models/housecleaning.model");
const { assertManualOccupancy, assertRemainingCapacity, validateRoomCatalogChange } = require("../services/room-integrity.service");

const today = Date.parse("2026-10-20");
const session = { inTransaction: () => true };
function fixture(capacity = 2) {
  return new RoomType({ property_id: "room-safety-test", name: "Standard", base_rate: 6500,
    physical_rooms: Array.from({ length: capacity }, (_, index) => ({ room_number: String(101 + index) })) });
}
function booking(type, overrides = {}) {
  return { reservation_no: "RES-SAFETY", status: "confirmed", check_in: "2026-10-21", check_out: "2026-10-23",
    rooms: [{ room_type_id: type._id, physical_room_id: type.physical_rooms[0]?._id }], ...overrides };
}
function stub(t, { reservations = [], blocks = [], links = null, rates = null, tasks = null } = {}) {
  const query = (value) => ({ session: async (valueSession) => { assert.equal(valueSession, session); return value; } });
  t.mock.method(Property, "findOne", () => query({ business_date: new Date(today) }));
  t.mock.method(Reservation, "find", () => query(reservations));
  t.mock.method(BusinessBlock, "find", () => query(blocks));
  t.mock.method(CrossBooking, "exists", () => query(links));
  t.mock.method(RatePlan, "exists", () => query(rates));
  t.mock.method(DailyRate, "exists", () => query(null));
  t.mock.method(HousekeepingTask, "exists", () => query(tasks));
  t.mock.method(HousekeepingActivity, "exists", () => query(null));
}
const change = (before, after, physicalRoomId, extra = {}) => validateRoomCatalogChange({ before, after, physicalRoomId, session, ...extra });

test("manual occupancy changes require the booking workflow in both directions", () => {
  const occupied = { room_number: "101", operational_status: "occupied", active: true };
  for (const status of ["available", "maintenance", "out_of_order"]) {
    assert.throws(() => assertManualOccupancy(occupied, { ...occupied, operational_status: status }), /Check out or move/);
  }
  assert.throws(() => assertManualOccupancy(occupied, null), /occupied/);
  assert.throws(() => assertManualOccupancy(occupied, { ...occupied, active: false }), /occupied/);
  assert.throws(() => assertManualOccupancy(null, occupied), /reservation check-in/);
  assert.doesNotThrow(() => assertManualOccupancy(occupied, { ...occupied, notes: "Needs towels" }));
});

test("catalog safety validation requires a transaction", async () => {
  await assert.rejects(validateRoomCatalogChange({ after: fixture() }), { statusCode: 500 });
});

test("new catalog entries cannot invent occupied rooms", async () => {
  const type = fixture(); type.physical_rooms[0].operational_status = "occupied";
  await assert.rejects(validateRoomCatalogChange({ after: type, session }), /reservation check-in/);
});

test("future physical assignments block maintenance even with spare rooms", async (t) => {
  const type = fixture(3); const before = type.toObject();
  stub(t, { reservations: [booking(type)] });
  type.physical_rooms[0].operational_status = "maintenance";
  await assert.rejects(change(before, type, type.physical_rooms[0]._id), /RES-SAFETY.*Reassign or cancel/);
});

test("a checked-in reservation protects a room even if its operational flag is stale", async (t) => {
  const type = fixture(); const before = type.toObject();
  stub(t, { reservations: [booking(type, { status: "checked_in", check_out: "2026-10-19" })] });
  type.physical_rooms[0].operational_status = "maintenance";
  await assert.rejects(change(before, type, type.physical_rooms[0]._id), /checked-in reservation/);
});

test("cancelled, no-show and checked-out bookings do not prevent maintenance", async (t) => {
  const type = fixture(); const before = type.toObject();
  stub(t, { reservations: ["cancelled", "no_show", "checked_out"].map((status) => booking(type, { status })) });
  type.physical_rooms[0].operational_status = "maintenance";
  await change(before, type, type.physical_rooms[0]._id);
});

test("completed reservation history prevents deletion and renaming but allows disabling", async (t) => {
  const type = fixture(); const before = type.toObject(); const id = type.physical_rooms[0]._id;
  stub(t, { reservations: [booking(type, { status: "checked_out" })] });
  await assert.rejects(change(before, type, id, { deleting: true }), /history/);
  type.physical_rooms[0].room_number = "999";
  await assert.rejects(change(before, type, id), /history/);
  type.physical_rooms[0].room_number = "101"; type.physical_rooms[0].active = false;
  await change(before, type, id);
});

test("a moved-away room can be taken out of service but its history cannot be deleted", async (t) => {
  const type = fixture(); const before = type.toObject(); const id = type.physical_rooms[0]._id;
  const record = booking(type, { status: "checked_in", check_in: "2026-10-19", rooms: [{ room_type_id: type._id,
    physical_room_id: type.physical_rooms[1]._id, current_assignment_from: "2026-10-20" }], room_moves: [{
    room_type_id: type._id, from_physical_room_id: id, to_physical_room_id: type.physical_rooms[1]._id,
    previous_assigned_from: "2026-10-19", business_date: "2026-10-20" }] });
  stub(t, { reservations: [record] });
  type.physical_rooms[0].operational_status = "maintenance";
  await change(before, type, id);
  await assert.rejects(change(before, type, id, { deleting: true }), /history/);
});

test("type disable protects unassigned future reservations including tentative and blocked", async (t) => {
  const type = fixture(); const before = type.toObject(); type.active = false;
  stub(t, { reservations: [booking(type, { status: "tentative", rooms: [{ room_type_id: type._id }] })] });
  await assert.rejects(change(before, type), /needed by RES-SAFETY/);
});

test("capacity reductions protect unassigned room nights but not unrelated past nights", () => {
  const type = fixture(1);
  const reservations = [booking(type, { rooms: [{ room_type_id: type._id }, { room_type_id: type._id }] })];
  assert.throws(() => assertRemainingCapacity({ type, reservations, blocks: [], today }), /2 are needed on 2026-10-21/);
  assert.doesNotThrow(() => assertRemainingCapacity({ type, reservations, blocks: [], today: Date.parse("2026-10-23") }));
});

test("non-overlapping stays are not summed across different days", () => {
  const type = fixture(1);
  const reservations = [booking(type, { check_out: "2026-10-22" }), booking(type, { check_in: "2026-10-22" })];
  assert.doesNotThrow(() => assertRemainingCapacity({ type, reservations, blocks: [], today }));
});

test("day-use consumes its date and cancelled/deleted reservations consume no capacity", () => {
  const type = fixture(0);
  const record = booking(type, { is_day_room: true, check_in: "2026-10-20", check_out: "2026-10-20" });
  assert.throws(() => assertRemainingCapacity({ type, reservations: [record], blocks: [], today }), /needed on 2026-10-20/);
  for (const extra of [{ status: "cancelled" }, { status: "no_show" }, { status: "checked_out" }, { deleted_at: new Date() }]) {
    assert.doesNotThrow(() => assertRemainingCapacity({ type, reservations: [{ ...record, ...extra }], blocks: [], today }));
  }
});

test("group holds protect capacity and pickups are not counted twice", () => {
  const type = fixture(1); const allocationId = new mongoose.Types.ObjectId();
  const group = { status: "active", check_in: "2026-10-21", check_out: "2026-10-23",
    allocations: [{ _id: allocationId, room_type_id: type._id, quantity: 2, released_quantity: 0 }] };
  const record = booking(type, { rooms: [{ room_type_id: type._id, business_block_allocation_id: allocationId }] });
  assert.throws(() => assertRemainingCapacity({ type, reservations: [record], blocks: [group], today }), /2 are needed/);
  group.allocations[0].quantity = 1;
  assert.doesNotThrow(() => assertRemainingCapacity({ type, reservations: [record], blocks: [group], today }));
  group.allocations[0].released_quantity = 1;
  assert.doesNotThrow(() => assertRemainingCapacity({ type, reservations: [], blocks: [group], today }));
});

test("cross-booking and housekeeping references prevent destructive catalog changes", async (t) => {
  const type = fixture(); const before = type.toObject();
  stub(t, { links: { _id: "link" } });
  await assert.rejects(change(before, type, type.physical_rooms[0]._id, { deleting: true }), /cross-booking links/);
});

test("saved rates prevent deletion of the referenced room type", async (t) => {
  const type = fixture(); stub(t, { rates: { _id: "rate" } });
  await assert.rejects(change(type.toObject(), undefined, undefined, { deleting: true }), /saved rates/);
});

test("harmless notes and cleaning-status changes need no reference queries", async () => {
  const type = fixture(); const before = type.toObject();
  type.physical_rooms[0].notes = "Extra towels"; type.physical_rooms[0].housekeeping_status = "dirty";
  await change(before, type, type.physical_rooms[0]._id);
});

test("disabling an already non-sellable physical room still checks future references", async (t) => {
  const type = fixture(); type.physical_rooms[0].operational_status = "maintenance";
  const before = type.toObject(); stub(t, { reservations: [booking(type)] });
  type.physical_rooms[0].active = false;
  await assert.rejects(change(before, type, type.physical_rooms[0]._id), /assigned to/);
});

test("disabling a zero-capacity type still checks its future reservations", async (t) => {
  const type = fixture(); type.physical_rooms.forEach((room) => { room.operational_status = "out_of_order"; });
  const before = type.toObject(); stub(t, { reservations: [booking(type)] }); type.active = false;
  await assert.rejects(change(before, type), /needed by/);
});

test("housekeeping history prevents deletion even without reservation references", async (t) => {
  const type = fixture(); stub(t, { tasks: { _id: "task" } });
  await assert.rejects(change(type.toObject(), type, type.physical_rooms[0]._id, { deleting: true }), /housekeeping history/);
});

test("tentative upcoming group allocations prevent disabling their room type", async (t) => {
  const type = fixture(); const before = type.toObject();
  stub(t, { blocks: [{ block_number: "GROUP-1", status: "tentative", check_in: "2026-10-21", check_out: "2026-10-23",
    allocations: [{ room_type_id: type._id, quantity: 1, released_quantity: 0 }] }] }); type.active = false;
  await assert.rejects(change(before, type), /GROUP-1/);
});
