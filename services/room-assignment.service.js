const mongoose = require("mongoose");
const RoomType = require("../db_models/rooms.model");
const UnassignedRoom = require("../db_models/unassigned-room.model");
const Reservation = require("../db_models/booking.model");
const Property = require("../db_models/property.model");
const { HousekeepingTask, HousekeepingActivity } = require("../db_models/housecleaning.model");
const { inventoryDay, physicalAssignments } = require("./booking-inventory-dates.service");
const { validateRoomCatalogChange, assertManualOccupancy } = require("./room-integrity.service");

const same = (a, b) => String(a || "") === String(b || "");
const key = value => String(value || "").trim().toLowerCase();
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
function requireTransaction(session) {
  if (!session?.inTransaction()) throw fail("Room assignments require an inventory transaction.", 500);
}
function roomReferences(propertyId, roomId) {
  return { property_id: propertyId, $or: [
    { "rooms.physical_room_id": roomId }, { "room_moves.from_physical_room_id": roomId },
    { "room_moves.to_physical_room_id": roomId }
  ] };
}
async function assertRoomCanMove(propertyId, room, session) {
  requireTransaction(session);
  assertManualOccupancy(room, null);
  if (room.housekeeping_status === "in_progress") throw fail(`Room ${room.room_number} is being cleaned. Complete its housekeeping work before unassigning or changing its type.`);
  const task = await HousekeepingTask.exists({ property_id: propertyId, physical_room_id: room._id,
    status: { $in: ["requested", "assigned", "in_progress"] } }).session(session);
  if (task) throw fail(`Room ${room.room_number} has open housekeeping work. Complete that work before unassigning or changing its type.`);
  const property = await Property.findOne({ property_id: propertyId }).select("business_date").session(session);
  const today = inventoryDay(property?.business_date || new Date());
  const reservations = await Reservation.find(roomReferences(propertyId, room._id)).session(session);
  const needed = reservations.find(record => !record.deleted_at && (
    (record.status === "checked_in" && record.rooms.some(item => same(item.physical_room_id, room._id))) ||
    (Reservation.ACTIVE_RESERVATION_STATUSES.includes(record.status) && physicalAssignments(record).some(item => same(item.physical_room_id, room._id) && item.end > today))
  ));
  if (needed) throw fail(`Room ${room.room_number} is needed by ${needed.reservation_no}. Move or reassign that reservation before unassigning or changing the room type.`);
}

async function assertRoomIdentityUnreferenced(propertyId, room, session) {
  requireTransaction(session);
  for (const Model of [Reservation, HousekeepingTask, HousekeepingActivity]) {
    const filter = Model === Reservation ? roomReferences(propertyId, room._id) : { property_id: propertyId, physical_room_id: room._id };
    if (await Model.exists(filter).session(session)) throw fail(`Room ${room.room_number} has reservation or housekeeping history. Keep its identity instead of deleting or renaming it.`);
  }
}

async function assertRoomNumbersAvailable(propertyId, rooms, session, currentTypeId) {
  requireTransaction(session);
  const types = await RoomType.find({ property_id: propertyId }).session(session);
  const unassigned = await UnassignedRoom.find({ property_id: propertyId }).session(session);
  const others = types.filter(type => !same(type._id, currentTypeId)).flatMap(type => type.physical_rooms);
  for (const room of rooms) {
    if ([...others, ...unassigned].some(other => !same(other._id, room._id) && key(other.room_number) === key(room.room_number))) {
      throw fail(`Room number ${room.room_number} already exists for this property. Assign the existing unassigned room instead of creating it again.`);
    }
  }
}

// Called inside the same transaction as the room-type details save. A failed
// capacity check rolls back both the room changes and the type details.
async function syncRoomNumbers(type, numbers, session) {
  requireTransaction(session);
  if (!Array.isArray(numbers) || numbers.length > 500 || numbers.some(number => typeof number !== "string" || !number.trim() || number.trim().length > 30)) {
    throw fail("room_numbers must contain valid room numbers (maximum 500).", 400);
  }
  numbers = numbers.map(number => number.trim());
  if (new Set(numbers.map(key)).size !== numbers.length) throw fail("Room numbers must be unique inside a room type.", 400);
  const before = type.toObject();
  const requested = new Set(numbers.map(key));
  // The existing room-type editor lists active rooms. Do not implicitly remove
  // hidden inactive rooms when an older client saves that list.
  const removed = type.physical_rooms.filter(room => room.active !== false && !requested.has(key(room.room_number)));
  for (const room of removed) {
    await assertRoomCanMove(type.property_id, room, session);
    await new UnassignedRoom({ ...room.toObject(), property_id: type.property_id, previous_room_type_id: type._id }).save({ session });
    room.deleteOne();
  }
  const parked = await UnassignedRoom.find({ property_id: type.property_id }).session(session);
  for (const number of numbers) {
    if (type.physical_rooms.some(room => key(room.room_number) === key(number))) continue;
    const existing = parked.find(room => key(room.room_number) === key(number));
    if (existing) {
      if (type.active === false) throw fail("Choose an active room type to assign this room.");
      await existing.deleteOne({ session });
      type.physical_rooms.push(existing.toObject());
    } else {
      type.physical_rooms.push({ room_number: number });
    }
  }
  await assertRoomNumbersAvailable(type.property_id, type.physical_rooms, session, type._id);
  await validateRoomCatalogChange({ before, after: type, session });
}

async function transferPhysicalRoom({ propertyId, roomId, targetTypeId, expectedTypeId, changes = {}, session }) {
  requireTransaction(session);
  if (!mongoose.isValidObjectId(roomId) || (targetTypeId !== null && !mongoose.isValidObjectId(targetTypeId))) throw fail("Select a valid room and room type.", 400);
  const source = await RoomType.findOne({ property_id: propertyId, "physical_rooms._id": roomId }).session(session);
  const parked = source ? null : await UnassignedRoom.findOne({ property_id: propertyId, _id: roomId }).session(session);
  const room = source ? source.physical_rooms.id(roomId) : parked;
  if (!room) throw fail("Physical room not found.", 404);
  if (expectedTypeId !== undefined && !same(expectedTypeId, source?._id)) throw fail("This room's assignment changed. Refresh the Physical Room List and try again.");
  const sameType = source && same(source._id, targetTypeId);
  if ((source && !sameType) || (parked && targetTypeId !== null)) await assertRoomCanMove(propertyId, room, session);
  const beforeRoom = room.toObject(), beforeType = source?.toObject();
  if (changes.room_number !== undefined && key(changes.room_number) !== key(room.room_number)) await assertRoomIdentityUnreferenced(propertyId, room, session);
  Object.assign(room, changes);
  assertManualOccupancy(beforeRoom, room);
  const target = targetTypeId === null ? null : sameType ? source : await RoomType.findOne({ property_id: propertyId, _id: targetTypeId, active: true }).session(session);
  if (targetTypeId !== null && !target) throw fail("Select an active room type in this property.", 404);
  await assertRoomNumbersAvailable(propertyId, [room], session, source?._id);
  if (sameType) {
    await validateRoomCatalogChange({ before: beforeType, after: source, physicalRoomId: room._id, session });
    await source.save({ session });
    return { room, type: source };
  }
  if (source) {
    source.physical_rooms.id(roomId).deleteOne();
    await validateRoomCatalogChange({ before: beforeType, after: source, session });
    await source.save({ session });
  } else if (target) await parked.deleteOne({ session });
  if (target) {
    target.physical_rooms.push(room.toObject());
    await target.save({ session });
    return { room: target.physical_rooms.id(roomId), type: target };
  }
  const unassigned = parked || new UnassignedRoom({ ...room.toObject(), property_id: propertyId, previous_room_type_id: source._id });
  await unassigned.save({ session });
  return { room: unassigned, type: null };
}

module.exports = { syncRoomNumbers, transferPhysicalRoom, assertRoomNumbersAvailable, assertRoomIdentityUnreferenced };
