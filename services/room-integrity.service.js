const Reservation = require("../db_models/booking.model");
const { ACTIVE_RESERVATION_STATUSES } = Reservation;
const BusinessBlock = require("../db_models/business-block.model");
const Property = require("../db_models/property.model");
const CrossBooking = require("../db_models/crossbooking.model");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const { HousekeepingTask, HousekeepingActivity } = require("../db_models/housecleaning.model");
const { inventoryDay, inventoryRange, physicalAssignments } = require("./booking-inventory-dates.service");

const conflict = (message) => Object.assign(new Error(message), { statusCode: 409 });
const same = (a, b) => String(a || "") === String(b || "");
const sellable = (room) => room.active !== false && !["maintenance", "out_of_order"].includes(room.operational_status);
const capacity = (type) => type.active === false ? 0 : type.physical_rooms.filter(sellable).length;
const currentRoom = (record, id) => (record.rooms || []).some((room) => same(room.physical_room_id, id));
const referencedRoom = (record, id) => currentRoom(record, id) || (record.room_moves || []).some((move) =>
  same(move.from_physical_room_id, id) || same(move.to_physical_room_id, id));
const active = (record) => !record.deleted_at && ACTIVE_RESERVATION_STATUSES.includes(record.status);
const label = (record) => record.reservation_no || "an existing reservation";

function assertManualOccupancy(before, after) {
  if (before?.operational_status === "occupied" && (!after || after.active === false || after.operational_status !== "occupied")) {
    throw conflict(`Room ${before.room_number} is occupied. Check out or move the guest before changing its status, disabling or deleting it.`);
  }
  if (after?.operational_status === "occupied" && before?.operational_status !== "occupied") {
    throw conflict("Use reservation check-in to mark a room occupied. Room status cannot be set to occupied manually.");
  }
}

// Pure, date-based capacity check. Evaluate only interval boundaries rather than
// every day of a potentially long future booking. Pickups replace group holds;
// they must not be counted twice. Day use consumes its arrival day.
function assertRemainingCapacity({ type, reservations, blocks, today }) {
  const typeId = type._id;
  const relevant = reservations.filter((record) => active(record) && inventoryRange(record).end > today);
  const held = blocks.filter((block) => !block.deleted_at && block.status === "active" && inventoryRange(block).end > today);
  const boundaries = new Set([today]);
  for (const record of [...relevant, ...held]) {
    const range = inventoryRange(record);
    if (range.start >= today) boundaries.add(range.start);
    if (range.end >= today) boundaries.add(range.end);
  }
  const stock = capacity(type);
  for (const day of [...boundaries].sort((a, b) => a - b)) {
    let used = 0;
    const picked = new Map();
    for (const record of relevant) {
      const range = inventoryRange(record);
      if (range.start > day || range.end <= day) continue;
      for (const room of record.rooms || []) {
        if (!same(room.room_type_id, typeId)) continue;
        used++;
        if (room.business_block_allocation_id) {
          const key = String(room.business_block_allocation_id);
          picked.set(key, (picked.get(key) || 0) + 1);
        }
      }
    }
    for (const block of held) {
      const range = inventoryRange(block);
      if (range.start > day || range.end <= day) continue;
      for (const allocation of block.allocations || []) {
        if (!same(allocation.room_type_id, typeId)) continue;
        used += Math.max(0, allocation.quantity - (allocation.released_quantity || 0) - (picked.get(String(allocation._id)) || 0));
      }
    }
    if (used > stock) throw conflict(`This change leaves ${type.name} with ${stock} sellable room(s), but ${used} are needed on ${new Date(day).toISOString().slice(0, 10)}. Reassign reservations or release group holds first.`);
  }
}

async function validateRoomCatalogChange({ before, after, physicalRoomId, deleting = false, session }) {
  if (!session?.inTransaction()) throw Object.assign(new Error("Room safety checks require an inventory transaction."), { statusCode: 500 });
  const source = before || after;
  const propertyId = source.property_id;
  if (!before) {
    for (const room of after.physical_rooms) assertManualOccupancy(null, room);
    return;
  }
  const oldRoom = physicalRoomId ? before.physical_rooms.find((room) => same(room._id, physicalRoomId)) : null;
  const newRoom = physicalRoomId && !deleting ? after.physical_rooms.find((room) => same(room._id, physicalRoomId)) : null;
  if (physicalRoomId) assertManualOccupancy(oldRoom, newRoom);
  else if (deleting || after.active === false) {
    for (const room of before.physical_rooms) assertManualOccupancy(room, null);
  }
  // Harmless catalog/housekeeping edits need no reservation scan. Check every
  // capacity reduction and identity change against persisted references.
  const reduction = deleting || capacity(after) < capacity(before);
  const disabling = !deleting && (oldRoom
    ? oldRoom.active !== false && newRoom.active === false
    : before.active !== false && after.active === false);
  const identityChange = oldRoom && newRoom && oldRoom.room_number !== newRoom.room_number;
  const typeRename = !physicalRoomId && !deleting && before.name !== after.name;
  const occupancyChange = oldRoom && newRoom && oldRoom.operational_status !== newRoom.operational_status;
  if (!reduction && !disabling && !identityChange && !typeRename && !occupancyChange) return;
  const property = await Property.findOne({ property_id: propertyId }, { business_date: 1 }).session(session);
  const today = inventoryDay(property?.business_date || new Date());
  // Include soft-deleted and completed reservations for deletion/rename safety.
  const reservations = await Reservation.find({ property_id: propertyId, $or: [
    { "rooms.room_type_id": before._id }, { "room_moves.room_type_id": before._id }
  ] }, { reservation_no: 1, status: 1, deleted_at: 1, check_in: 1, check_out: 1, is_day_room: 1, rooms: 1, room_moves: 1 }).session(session);
  const blocks = await BusinessBlock.find({ property_id: propertyId, "allocations.room_type_id": before._id },
    { block_number: 1, status: 1, deleted_at: 1, check_in: 1, check_out: 1, allocations: 1 }).session(session);
  if (oldRoom) {
    const inHouse = reservations.find((record) => !record.deleted_at && record.status === "checked_in" && currentRoom(record, oldRoom._id));
    if (inHouse && (deleting || newRoom.active === false || occupancyChange || identityChange)) {
      throw conflict(`Room ${oldRoom.room_number} has checked-in reservation ${label(inHouse)}. Check out or move the guest first.`);
    }
    if (deleting || identityChange) {
      const reference = reservations.find((record) => referencedRoom(record, oldRoom._id));
      if (reference) throw conflict(`Room ${oldRoom.room_number} is referenced by ${label(reference)} or its move history. Keep its identity; disable it when no active stays remain instead of deleting or renaming it.`);
    }
    if (deleting || disabling || (occupancyChange && !sellable(newRoom))) {
      const upcoming = reservations.find((record) => active(record) && physicalAssignments(record).some((assignment) =>
        same(assignment.physical_room_id, oldRoom._id) && assignment.end > today));
      if (upcoming) throw conflict(`Room ${oldRoom.room_number} is assigned to ${label(upcoming)}. Reassign or cancel that reservation before taking the room out of service.`);
    }
  } else if (deleting || after.active === false) {
    const inHouse = reservations.find((record) => !record.deleted_at && record.status === "checked_in");
    const upcoming = reservations.find((record) => active(record) && inventoryRange(record).end > today);
    const group = blocks.find((block) => !block.deleted_at && ["active", "tentative"].includes(block.status) && inventoryRange(block).end > today &&
      block.allocations.some((allocation) => same(allocation.room_type_id, before._id) && allocation.quantity > (allocation.released_quantity || 0)));
    if (inHouse || upcoming) throw conflict(`Room type ${before.name} is needed by ${label(inHouse || upcoming)}. Reassign or cancel its reservations before disabling or deleting it.`);
    if (group) throw conflict(`Room type ${before.name} is needed by group ${group.block_number}. Release or reassign that group before disabling or deleting it.`);
  }
  if ((deleting && !physicalRoomId) || typeRename) {
    if (reservations.length || blocks.length) throw conflict(`Room type ${before.name} has reservation/group history. Keep its identity and disable it when no active stays remain instead of deleting or renaming it.`);
  }
  if (deleting || identityChange || typeRename) {
    const roomIds = oldRoom ? [oldRoom._id] : before.physical_rooms.map((room) => room._id);
    const links = await CrossBooking.exists({ property_id: propertyId, $or: [{ room_a_id: { $in: roomIds } }, { room_b_id: { $in: roomIds } }] }).session(session);
    if (links) throw conflict("Remove the room's cross-booking links before deleting or renaming it.");
    for (const Model of [HousekeepingTask, HousekeepingActivity]) {
      if (await Model.exists({ property_id: propertyId, ...(oldRoom ? { physical_room_id: oldRoom._id } : { room_type_id: before._id }) }).session(session)) {
        throw conflict("This room has housekeeping history. Keep its identity and disable it when no active stays remain instead of deleting or renaming it.");
      }
    }
    if (!physicalRoomId) {
      if (await RatePlan.exists({ property_id: propertyId, "room_type_rates.room_type_id": before._id }).session(session) ||
          await DailyRate.exists({ property_id: propertyId, room_type_id: before._id }).session(session)) {
        throw conflict("This room type is referenced by saved rates. Disable it instead of deleting or renaming it.");
      }
    }
  }
  // Removing one physical room reduces the surviving type's capacity too.
  if (reduction && (!deleting || physicalRoomId)) assertRemainingCapacity({ type: after, reservations, blocks, today });
}

module.exports = { validateRoomCatalogChange, assertManualOccupancy, assertRemainingCapacity };
