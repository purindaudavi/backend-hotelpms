const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");
const RoomType = require("../db_models/rooms.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const { reassignConfirmedRoom, swapConfirmedRooms } = require("../services/room-move.service");
const {
  validateReservationInventory,
  validateBusinessBlockInventory
} = require("../services/booking-availability.service");

const typeId = new mongoose.Types.ObjectId();
const propertyId = "nightly-inventory-test";
const date = (value) => new Date(`${value}T00:00:00.000Z`);
const room = (overrides = {}) => ({ room_type_id: typeId, adults: 1, children: 0, ...overrides });

for (const status of ["maintenance", "out_of_order"]) {
  test(`cannot assign a specific ${status} room even with spare type capacity`, async (t) => {
    const type = new RoomType({ _id: typeId, property_id: propertyId, name: "Standard", base_rate: 6500,
      physical_rooms: [{ room_number: "101", operational_status: status }, { room_number: "102" }] });
    const { validate } = setup(t, { roomTypes: [type] });
    await assert.rejects(validate({ rooms: [room({ physical_room_id: type.physical_rooms[0]._id })] }), /Select another room/);
  });
}

function booking(from, to, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), property_id: propertyId,
    status: "confirmed", check_in: date(from), check_out: date(to),
    rooms: [room()], ...overrides
  };
}

function block(from, to, quantity = 1, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), property_id: propertyId, status: "active",
    check_in: date(from), check_out: date(to),
    allocations: [{ _id: new mongoose.Types.ObjectId(), room_type_id: typeId, quantity, released_quantity: 0 }],
    ...overrides
  };
}

// Apply the filters and projections used by the service, without a database.
// In particular, missing date fields in a query projection must fail these tests.
function matches(record, filter) {
  if (filter.property_id !== undefined && record.property_id !== filter.property_id) return false;
  if (filter.$or && !filter.$or.some((clause) => matches(record, clause))) return false;
  if (filter.is_day_room !== undefined) {
    if (typeof filter.is_day_room === "boolean" && record.is_day_room !== filter.is_day_room) return false;
    if (filter.is_day_room.$ne !== undefined && record.is_day_room === filter.is_day_room.$ne) return false;
  }
  if (filter._id?.$ne && String(record._id) === String(filter._id.$ne)) return false;
  if (filter.deleted_at && record.deleted_at !== undefined) return false;
  if (filter.status?.$in && !filter.status.$in.includes(record.status)) return false;
  if (typeof filter.status === "string" && record.status !== filter.status) return false;
  if (filter.check_in?.$lt && !(record.check_in < filter.check_in.$lt)) return false;
  if (filter.check_in?.$gte && !(record.check_in >= filter.check_in.$gte)) return false;
  if (filter.check_out?.$gt && !(record.check_out > filter.check_out.$gt)) return false;
  const assigned = filter.rooms?.$elemMatch?.physical_room_id;
  if (assigned && !record.rooms.some((line) => assigned.$in
    ? assigned.$in.some((id) => String(id) === String(line.physical_room_id))
    : String(assigned) === String(line.physical_room_id))) return false;
  return true;
}

function project(record, projection) {
  if (!projection || !record) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => key === "_id" || projection[key]));
}

function setup(t, { capacity = 2, reservations = [], blocks = [], physicalRooms, roomTypes } = {}) {
  const type = new RoomType({
    _id: typeId, property_id: propertyId, name: "Standard", active: true,
    maximum_adults: 2, maximum_children: 2,
    physical_rooms: physicalRooms || Array.from({ length: capacity }, (_, index) => ({ room_number: String(101 + index) }))
  });
  const calls = [];
  const query = (value) => ({ session(session) { calls.push(session); return Promise.resolve(value); } });
  t.mock.method(RoomType, "find", (filter) => query((roomTypes || [type]).filter((item) =>
    item.property_id === filter.property_id && item.active && filter._id.$in.some((id) => String(id) === String(item._id))
  )));
  t.mock.method(Reservation, "find", (filter, projection) => query(reservations.filter((item) => matches(item, filter)).map((item) => project(item, projection))));
  t.mock.method(Reservation, "exists", (filter) => query(reservations.some((item) => matches(item, filter)) ? { _id: "found" } : null));
  t.mock.method(Reservation, "findOne", (filter, projection) => query(project(reservations.find((item) => matches(item, filter)) || null, projection)));
  t.mock.method(BusinessBlock, "find", (filter, projection) => query(blocks.filter((item) => matches(item, filter)).map((item) => project(item, projection))));
  return {
    type, calls,
    validate: (overrides = {}) => validateReservationInventory({
      propertyId, checkIn: date("2026-10-20"), checkOut: date("2026-10-22"), rooms: [room()], ...overrides
    })
  };
}

test("accepts a two-night stay when different bookings use one room on each night", async (t) => {
  const { validate } = setup(t, { reservations: [booking("2026-10-20", "2026-10-21"), booking("2026-10-21", "2026-10-22")] });
  await validate();
});

test("reassigns a confirmed reservation's selected room without changing its stay or financials", async (t) => {
  const { type } = setup(t, { capacity: 3 });
  const [source, destination, other] = type.physical_rooms;
  const lineFor = (physicalRoom) => room({ physical_room_id: physicalRoom._id, room_number: physicalRoom.room_number,
    room_type_name: type.name, effective_nightly_rate: 6500 });
  const reservation = new Reservation(booking("2026-10-20", "2026-10-22", {
    reservation_no: "REASSIGN-1",
    booker: { name: "Test Guest", phone: "+94710000000", email: "guest@example.test", country: "LK" },
    rooms: [lineFor(source), lineFor(other)],
    financial_summary: { room_total: 26000, grand_total: 26000, paid_total: 10000 }
  }));
  await reservation.validate();
  const original = reservation.toObject();
  const session = { inTransaction: () => true };
  const save = t.mock.method(reservation, "save", async (options) => {
    assert.equal(options.session, session);
    await reservation.validate();
  });
  const audit = t.mock.method(BookingAuditLog, "create", async (entries, options) => {
    assert.equal(options.session, session);
    return entries;
  });
  const assignment = {
    room_line_id: String(reservation.rooms[0]._id), from_physical_room_id: String(source._id),
    to_physical_room_id: String(destination._id), expected_version: 0
  };
  const move = (payload = assignment) => reassignConfirmedRoom({ reservation, assignment: payload, actor: { name: "Front Desk" }, session });
  await assert.rejects(move({ ...assignment, expected_version: 1 }), /reservation changed/);
  await move();
  assert.equal(reservation.reservation_no, original.reservation_no);
  assert.equal(reservation.status, "confirmed");
  assert.deepEqual(reservation.check_in, original.check_in);
  assert.deepEqual(reservation.check_out, original.check_out);
  assert.deepEqual(reservation.booker.toObject(), original.booker);
  assert.deepEqual(reservation.financial_summary.toObject(), original.financial_summary);
  assert.equal(String(reservation.rooms[0]._id), assignment.room_line_id);
  assert.equal(reservation.rooms[0].room_number, destination.room_number);
  assert.equal(reservation.rooms[0].effective_nightly_rate, 6500);
  assert.deepEqual(reservation.rooms[1].toObject(), original.rooms[1]);
  assert.equal(reservation.room_moves.length, 0);
  assert.equal(save.mock.callCount(), 1);
  assert.match(audit.mock.calls[0].arguments[0][0].description, /room 101 to 102 before check-in/);
  await assert.rejects(move(), /reservation changed/);
});

test("a confirmed room reassignment rejects a destination booked on a later night", async (t) => {
  const physicalRooms = [{ _id: new mongoose.Types.ObjectId(), room_number: "101" }, { _id: new mongoose.Types.ObjectId(), room_number: "102" }];
  const [source, destination] = physicalRooms;
  const laterBooking = booking("2026-10-21", "2026-10-22", { rooms: [room({ physical_room_id: destination._id, room_number: "102" })] });
  setup(t, { physicalRooms, reservations: [laterBooking] });
  const reservation = new Reservation(booking("2026-10-20", "2026-10-22", { rooms: [room({ physical_room_id: source._id, room_number: "101" })] }));
  const save = t.mock.method(reservation, "save", async () => {});
  const options = { reservation, session: { inTransaction: () => true }, assignment: {
    room_line_id: String(reservation.rooms[0]._id), from_physical_room_id: String(source._id),
    to_physical_room_id: String(destination._id), expected_version: 0
  } };
  reservation.status = "checked_in";
  await assert.rejects(reassignConfirmedRoom(options), /awaiting check-in/);
  reservation.status = "confirmed";
  await assert.rejects(reassignConfirmedRoom(options), /Room 102 is already booked/);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(String(reservation.rooms[0].physical_room_id), String(source._id));
});

test("a swap validates both stays against the proposed rooms and preserves the original reservations until both checks pass", async (t) => {
  const physicalRooms = ["101", "103"].map(room_number => ({ _id: new mongoose.Types.ObjectId(), room_number }));
  const [firstRoom, secondRoom] = physicalRooms;
  const makeStay = (name, assigned, checkIn, checkOut) => new Reservation(booking(checkIn, checkOut, {
    reservation_no: name, booker: { name }, rooms: [room({ physical_room_id: assigned._id, room_number: assigned.room_number,
      room_type_name: "Standard", effective_nightly_rate: 6500 })], financial_summary: { grand_total: 13000, paid_total: 1000 }
  }));
  const reservation = makeStay("RES-ONE", firstRoom, "2026-10-20", "2026-10-22");
  const otherReservation = makeStay("RES-TWO", secondRoom, "2026-10-21", "2026-10-24");
  const [firstBefore, secondBefore] = [reservation.toObject(), otherReservation.toObject()];
  const third = booking("2026-10-22", "2026-10-24", { rooms: [room({ physical_room_id: firstRoom._id })] });
  const booked = [firstBefore, secondBefore, third];
  setup(t, { physicalRooms, reservations: booked });
  const session = { inTransaction: () => true };
  const saves = [reservation, otherReservation].map(item => t.mock.method(item, "save", async options => assert.equal(options.session, session)));
  const audit = t.mock.method(BookingAuditLog, "create", async (entries, options) => {
    assert.equal(options.session, session);
    return entries;
  });
  const forStay = (item) => ({ room_line_id: String(item.rooms[0]._id), from_physical_room_id: String(item.rooms[0].physical_room_id), expected_version: 0 });
  const assignment = { ...forStay(reservation), other: forStay(otherReservation) };
  const swap = () => swapConfirmedRooms({ reservation, otherReservation, assignment, session });
  await assert.rejects(swap(), /Room 101 is already booked/);
  assert.equal(saves[0].mock.callCount(), 0);
  assert.equal(saves[1].mock.callCount(), 0);
  booked.pop();
  otherReservation.status = "checked_in";
  await assert.rejects(swap(), /awaiting check-in/);
  otherReservation.status = "confirmed";
  otherReservation.__v = 1;
  await assert.rejects(swap(), /reservation changed/);
  assignment.other.expected_version = 1;
  await swap();
  assert.equal(reservation.rooms[0].room_number, "103");
  assert.equal(otherReservation.rooms[0].room_number, "101");
  assert.deepEqual(reservation.check_out, firstBefore.check_out);
  assert.deepEqual(otherReservation.check_out, secondBefore.check_out);
  assert.deepEqual(reservation.financial_summary.toObject(), firstBefore.financial_summary);
  assert.deepEqual(otherReservation.financial_summary.toObject(), secondBefore.financial_summary);
  assert.ok(saves.every(item => item.mock.callCount() === 1));
  assert.deepEqual(audit.mock.calls.map(call => call.arguments[0][0].action), ["reservation_rooms_swapped", "reservation_rooms_swapped"]);
});

test("rejects the particular sold-out night, not the sum across a stay", async (t) => {
  const { validate } = setup(t, { reservations: [booking("2026-10-21", "2026-10-22", { rooms: [room(), room()] })] });
  await assert.rejects(validate(), { statusCode: 409, message: /0 sellable room\(s\).*2026-10-21/ });
});

test("a multi-room request must fit on every night", async (t) => {
  const { validate } = setup(t, { capacity: 3, reservations: [booking("2026-10-21", "2026-10-22", { rooms: [room(), room()] })] });
  await assert.rejects(validate({ rooms: [room(), room()] }), /1 sellable room\(s\).*2026-10-21/);
});

test("checkout is exclusive and adjacent stays do not consume the requested nights", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-19", "2026-10-20"), booking("2026-10-22", "2026-10-23")] });
  await validate();
});

test("counts reservations spanning the entire stay", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-19", "2026-10-23")] });
  await assert.rejects(validate(), /0 sellable room\(s\).*2026-10-20/);
});

test("handles month and year boundaries", async (t) => {
  const { validate } = setup(t, { reservations: [booking("2026-12-31", "2027-01-01"), booking("2027-01-01", "2027-01-02")] });
  await validate({ checkIn: date("2026-12-31"), checkOut: date("2027-01-02") });
});

test("editing excludes the reservation itself but not other bookings", async (t) => {
  const existing = booking("2026-10-20", "2026-10-22");
  const { validate } = setup(t, { capacity: 1, reservations: [existing] });
  await validate({ excludeReservationId: existing._id });
  await assert.rejects(validate(), /0 sellable/);
});

for (const status of ["tentative", "confirmed", "checked_in", "blocked"]) {
  test(`${status} reservations consume nightly capacity`, async (t) => {
    const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-20", "2026-10-22", { status })] });
    await assert.rejects(validate(), /0 sellable/);
  });
}

test("ignores cancelled, no-show, checked-out, deleted and other-property bookings", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [
    ...["cancelled", "no_show", "checked_out"].map((status) => booking("2026-10-20", "2026-10-22", { status })),
    booking("2026-10-20", "2026-10-22", { deleted_at: new Date() }),
    booking("2026-10-20", "2026-10-22", { property_id: "another-hotel" })
  ] });
  await validate();
});

test("inactive, maintenance and out-of-order rooms do not add sellable capacity", async (t) => {
  const { validate } = setup(t, { physicalRooms: [
    { room_number: "101" }, { room_number: "102", active: false },
    { room_number: "103", operational_status: "maintenance" },
    { room_number: "104", operational_status: "out_of_order" }
  ] });
  await validate();
  await assert.rejects(validate({ rooms: [room(), room()] }), /1 sellable/);
});

test("counts disjoint group holds per night rather than across the whole stay", async (t) => {
  const { validate } = setup(t, { blocks: [block("2026-10-20", "2026-10-21"), block("2026-10-21", "2026-10-22")] });
  await validate();
});

test("subtracts group pickup only on the nights that the pickup occupies", async (t) => {
  const held = block("2026-10-20", "2026-10-22");
  const picked = booking("2026-10-20", "2026-10-21", {
    business_block_id: held._id,
    rooms: [room({ business_block_allocation_id: held.allocations[0]._id })]
  });
  const { validate } = setup(t, { blocks: [held], reservations: [picked] });
  await validate();
  await assert.rejects(validate({ checkIn: date("2026-10-21"), rooms: [room(), room()] }), /1 sellable.*2026-10-21/);
});

test("staggered group pickups cannot release another night's unpicked hold", async (t) => {
  const held = block("2026-10-20", "2026-10-22", 2);
  const reservations = [booking("2026-10-20", "2026-10-21", {
    business_block_id: held._id,
    rooms: [room({ business_block_allocation_id: held.allocations[0]._id }), room({ business_block_allocation_id: held.allocations[0]._id })]
  })];
  const { validate } = setup(t, { capacity: 2, blocks: [held], reservations });
  await assert.rejects(validate({ checkIn: date("2026-10-21") }), /0 sellable.*2026-10-21/);
});

test("released allocations no longer hold rooms", async (t) => {
  const held = block("2026-10-20", "2026-10-22", 2);
  held.allocations[0].released_quantity = 1;
  const { validate } = setup(t, { blocks: [held] });
  await validate();
});

test("ignores inactive, deleted and other-property group holds", async (t) => {
  const { validate } = setup(t, { capacity: 1, blocks: [
    ...["tentative", "released", "cancelled", "completed"].map((status) => block("2026-10-20", "2026-10-22", 1, { status })),
    block("2026-10-20", "2026-10-22", 1, { deleted_at: new Date() }),
    block("2026-10-20", "2026-10-22", 1, { property_id: "another-hotel" })
  ] });
  await validate();
});

test("block pickup retains the existing exclusion of its own block and pickups", async (t) => {
  const held = block("2026-10-20", "2026-10-22", 2);
  const { validate } = setup(t, { blocks: [held], reservations: [booking("2026-10-20", "2026-10-22", { business_block_id: held._id })] });
  await validate({ linkedBusinessBlockId: held._id, rooms: [room(), room()] });
});

test("creating/editing a business block uses nightly capacity too", async (t) => {
  const held = block("2026-10-20", "2026-10-22");
  const { calls } = setup(t, { reservations: [booking("2026-10-20", "2026-10-21"), booking("2026-10-21", "2026-10-22")] });
  const session = { testSession: true };
  await validateBusinessBlockInventory({ block: held, session });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((value) => value === session));
});

test("cannot assign a specific physical room occupied on any requested night", async (t) => {
  const physicalRoomId = new mongoose.Types.ObjectId();
  const reservations = [booking("2026-10-21", "2026-10-22", { rooms: [room({ physical_room_id: physicalRoomId })] })];
  const { validate } = setup(t, { reservations, physicalRooms: [
    { _id: physicalRoomId, room_number: "101" }, { room_number: "102" }
  ] });
  await assert.rejects(validate({ rooms: [room({ physical_room_id: physicalRoomId })] }), /Room 101 is already booked.*Refresh availability and try again/);
});

test("a free physical room can be assigned for the entire two-night stay", async (t) => {
  const occupiedRoomId = new mongoose.Types.ObjectId();
  const freeRoomId = new mongoose.Types.ObjectId();
  const { validate } = setup(t, {
    physicalRooms: [{ _id: occupiedRoomId, room_number: "101" }, { _id: freeRoomId, room_number: "102" }],
    reservations: [
      booking("2026-10-20", "2026-10-21", { rooms: [room({ physical_room_id: occupiedRoomId })] }),
      booking("2026-10-21", "2026-10-22", { rooms: [room({ physical_room_id: occupiedRoomId })] })
    ]
  });
  const requested = room({ physical_room_id: freeRoomId });
  await validate({ rooms: [requested] });
  assert.equal(requested.room_number, "102");
});

test("same-day requests still undergo a capacity check", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-19", "2026-10-22")] });
  await assert.rejects(validate({ checkOut: date("2026-10-20") }), /0 sellable.*2026-10-20/);
});

test("does not pool capacity across different room types", async (t) => {
  const standardType = new RoomType({ _id: typeId, property_id: propertyId, name: "Standard", active: true, maximum_adults: 2, maximum_children: 2, physical_rooms: [{ room_number: "101" }, { room_number: "102" }] });
  const otherType = new RoomType({ _id: new mongoose.Types.ObjectId(), property_id: propertyId, name: "Deluxe", active: true, maximum_adults: 2, maximum_children: 2, physical_rooms: [{ room_number: "201" }] });
  const { validate } = setup(t, { roomTypes: [standardType, otherType], reservations: [booking("2026-10-21", "2026-10-22", { rooms: [room({ room_type_id: otherType._id })] })] });
  await assert.rejects(validate({ rooms: [room(), room({ room_type_id: otherType._id })] }), /Deluxe has only 0 sellable.*2026-10-21/);
});

test("two same-day stays cannot take the same last room", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-20", "2026-10-20", { is_day_room: true })] });
  await assert.rejects(validate({ checkOut: date("2026-10-20"), isDayRoom: true }), /0 sellable.*2026-10-20/);
});

test("day use conflicts with an overnight arrival on that same day", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-20", "2026-10-22")] });
  await assert.rejects(validate({ checkOut: date("2026-10-20"), isDayRoom: true }), /0 sellable.*2026-10-20/);
});

test("overnight arrivals cannot miss existing day use on the arrival date", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-20", "2026-10-20", { is_day_room: true })] });
  await assert.rejects(validate(), /0 sellable.*2026-10-20/);
});

test("day use inside a longer stay is counted only on its own date", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-21", "2026-10-21", { is_day_room: true })] });
  await assert.rejects(validate(), /0 sellable.*2026-10-21/);
});

test("day use on an overnight checkout date does not add an extra occupied night", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-22", "2026-10-22", { is_day_room: true })] });
  await validate();
});

test("day use may follow the previous overnight checkout date", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-19", "2026-10-20")] });
  await validate({ checkOut: date("2026-10-20"), isDayRoom: true });
});

test("day use on adjacent dates does not conflict", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-21", "2026-10-21", { is_day_room: true })] });
  await validate({ checkOut: date("2026-10-20"), isDayRoom: true });
});

test("editing a day-use reservation excludes itself", async (t) => {
  const existing = booking("2026-10-20", "2026-10-20", { is_day_room: true });
  const { validate } = setup(t, { capacity: 1, reservations: [existing] });
  await validate({ checkOut: date("2026-10-20"), isDayRoom: true, excludeReservationId: existing._id });
});

for (const existingDayUse of [false, true]) {
  test(`physical assignment detects day-use overlap (existing day use: ${existingDayUse})`, async (t) => {
    const physicalId = new mongoose.Types.ObjectId();
    const { validate } = setup(t, {
      physicalRooms: [{ _id: physicalId, room_number: "101" }, { room_number: "102" }],
      reservations: [booking("2026-10-20", existingDayUse ? "2026-10-20" : "2026-10-22", {
        is_day_room: existingDayUse, rooms: [room({ physical_room_id: physicalId })]
      })]
    });
    await assert.rejects(validate({
      rooms: [room({ physical_room_id: physicalId })],
      checkOut: date(existingDayUse ? "2026-10-22" : "2026-10-20"), isDayRoom: !existingDayUse
    }), /Room 101 is already booked/);
  });
}

test("day use respects a group hold starting on the same date", async (t) => {
  const { validate } = setup(t, { capacity: 1, blocks: [block("2026-10-20", "2026-10-22")] });
  await assert.rejects(validate({ checkOut: date("2026-10-20"), isDayRoom: true }), /0 sellable.*2026-10-20/);
});

test("a group hold ending on the day-use date does not block that date", async (t) => {
  const { validate } = setup(t, { capacity: 1, blocks: [block("2026-10-19", "2026-10-20")] });
  await validate({ checkOut: date("2026-10-20"), isDayRoom: true });
});

test("group activation cannot miss existing day use at the block start", async (t) => {
  const held = block("2026-10-20", "2026-10-22");
  setup(t, { capacity: 1, reservations: [booking("2026-10-20", "2026-10-20", { is_day_room: true })] });
  await assert.rejects(validateBusinessBlockInventory({ block: held }), /0 sellable.*2026-10-20/);
});

test("day use still obeys active status, deletion and property scope", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [
    booking("2026-10-20", "2026-10-20", { is_day_room: true, status: "cancelled" }),
    booking("2026-10-20", "2026-10-20", { is_day_room: true, status: "no_show" }),
    booking("2026-10-20", "2026-10-20", { is_day_room: true, deleted_at: new Date() }),
    booking("2026-10-20", "2026-10-20", { is_day_room: true, property_id: "another-hotel" })
  ] });
  await validate({ checkOut: date("2026-10-20"), isDayRoom: true });
});

test("legacy day-use records with a later checkout still consume only their arrival day", async (t) => {
  const { validate } = setup(t, { capacity: 1, reservations: [booking("2026-10-20", "2026-10-22", { is_day_room: true })] });
  await validate({ checkIn: date("2026-10-21"), checkOut: date("2026-10-21"), isDayRoom: true });
});
