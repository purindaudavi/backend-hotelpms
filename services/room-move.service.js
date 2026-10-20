const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const RoomType = require("../db_models/rooms.model");
const Property = require("../db_models/property.model");
const { HousekeepingActivity, HousekeepingTask } = require("../db_models/housecleaning.model");
const { inventoryDay, inventoryRange } = require("./booking-inventory-dates.service");
const { validateReservationInventory } = require("./booking-availability.service");
const { writeAuditLog } = require("./booking-audit.service");

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });

async function moveInHouseRooms({ reservation, moves, businessDate, reason, actor, requestId = "", session }) {
  if (!session?.inTransaction()) throw error(500, "Room moves require a protected database transaction.");
  if (reservation.status !== "checked_in") throw error(409, "Only a checked-in reservation can be moved.");
  if (!Array.isArray(moves) || !moves.length || moves.length > reservation.rooms.length) throw error(400, "Select the room assignment to move.");
  reason = String(reason || "").trim();
  if (!reason || reason.length > 500) throw error(400, "Enter a move reason of 1 to 500 characters.");
  const property = await Property.findOne({ property_id: reservation.property_id }, { business_date: 1 }).session(session);
  if (businessDate && !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw error(400, "The move business date must use YYYY-MM-DD.");
  if (businessDate && new Date(inventoryDay(businessDate)).toISOString().slice(0, 10) !== businessDate) throw error(400, "Select a valid move business date.");
  const effectiveDate = inventoryDay(property?.business_date || businessDate || new Date());
  if (businessDate && inventoryDay(businessDate) !== effectiveDate) throw error(409, "The property's business date changed. Refresh before moving the guest.");
  const range = inventoryRange(reservation);
  if (effectiveDate < range.start || effectiveDate >= range.end) throw error(409, "The move business date is outside the remaining stay. Extend the stay or check out the guest first.");
  const selectedLines = new Set();
  const targets = new Set();
  const roomTypes = new Map();
  const planned = [];
  for (const move of moves) {
    if (!move || typeof move !== "object" || Array.isArray(move)) throw error(400, "Select a valid room move.");
    for (const key of ["room_line_id", "from_physical_room_id", "to_physical_room_id"]) {
      if (!mongoose.isValidObjectId(move[key])) throw error(400, "Select a valid current assignment and destination room.");
    }
    const line = reservation.rooms.id(move.room_line_id);
    if (!line || selectedLines.has(String(line._id))) throw error(400, "Select each reservation room only once.");
    selectedLines.add(String(line._id));
    if (String(line.physical_room_id || "") !== String(move.from_physical_room_id)) throw error(409, "This guest's room assignment changed. Refresh before moving the guest.");
    if (String(move.to_physical_room_id) === String(line.physical_room_id)) throw error(400, "Select a different destination room.");
    if (targets.has(String(move.to_physical_room_id))) throw error(409, "The same destination room cannot be selected twice.");
    targets.add(String(move.to_physical_room_id));
    const typeId = String(line.room_type_id);
    if (!roomTypes.has(typeId)) roomTypes.set(typeId, await RoomType.findOne({ _id: line.room_type_id, property_id: reservation.property_id, active: true }).session(session));
    const type = roomTypes.get(typeId);
    const from = type?.physical_rooms.id(line.physical_room_id);
    const to = type?.physical_rooms.id(move.to_physical_room_id);
    if (!from || from.operational_status !== "occupied") throw error(409, "The original room is not marked occupied. Review its status before moving the guest.");
    if (!to || !to.active) throw error(409, "Choose an active destination in the same room type. Room-type upgrades need a separate rate review.");
    if (to.operational_status !== "available") throw error(409, `Room ${to.room_number} is not available for an in-house move.`);
    if (!["clean", "inspected"].includes(to.housekeeping_status)) throw error(409, `Room ${to.room_number} must be clean or inspected before moving the guest.`);
    const previousStart = line.current_assignment_from || reservation.check_in;
    if (inventoryDay(previousStart) > effectiveDate) throw error(409, "A room move cannot be backdated before the current assignment.");
    const otherOccupant = await Reservation.exists({ property_id: reservation.property_id, _id: { $ne: reservation._id }, status: "checked_in", deleted_at: { $exists: false }, rooms: { $elemMatch: { physical_room_id: from._id } } }).session(session);
    if (otherOccupant) throw error(409, `Room ${from.room_number} is assigned to another in-house reservation. Review the room assignments first.`);
    planned.push({ line, type, from, to, previousStart });
    line.physical_room_id = to._id;
    line.room_number = to.room_number;
    line.current_assignment_from = new Date(effectiveDate);
  }

  await validateReservationInventory({ propertyId: reservation.property_id, checkIn: new Date(effectiveDate), checkOut: reservation.check_out,
    isDayRoom: reservation.is_day_room, rooms: reservation.rooms, excludeReservationId: reservation._id, linkedBusinessBlockId: reservation.business_block_id, session });

  const movedAt = new Date();
  for (const { line, type, from, to, previousStart } of planned) {
    from.operational_status = "available";
    from.housekeeping_status = "dirty";
    to.operational_status = "occupied";
    reservation.room_moves.push({ room_line_id: line._id, room_type_id: type._id, room_type_name: type.name,
      from_physical_room_id: from._id, from_room_number: from.room_number, to_physical_room_id: to._id, to_room_number: to.room_number,
      previous_assigned_from: previousStart, business_date: new Date(effectiveDate), moved_at: movedAt, actor, reason });
    let task = await HousekeepingTask.findOne({ property_id: reservation.property_id, physical_room_id: from._id }).session(session);
    if (!task) task = new HousekeepingTask({ property_id: reservation.property_id, physical_room_id: from._id, room_type_id: type._id, room_number: from.room_number, room_type_name: type.name });
    task.status = "assigned";
    task.assigned_at = movedAt;
    task.started_at = null;
    task.completed_at = null;
    task.inspected_at = null;
    task.updated_by = actor;
    await task.save({ session });
    await HousekeepingActivity.create([{ property_id: reservation.property_id, physical_room_id: from._id, room_type_id: type._id, task_id: task._id,
      room_number: from.room_number, room_type_name: type.name, action: "room_marked_dirty", from_status: "occupied", to_status: "dirty",
      notes: `In-house move to ${to.room_number}: ${reason}`, actor, request_id: requestId }], { session });
    await writeAuditLog({ propertyId: reservation.property_id, entityType: "reservation", entityId: reservation._id, action: "reservation_room_moved",
      description: `Guest moved from room ${from.room_number} to ${to.room_number} on ${new Date(effectiveDate).toISOString().slice(0, 10)}. ${reason}`,
      changes: [{ field: `rooms.${line._id}.physical_room_id`, from: String(from._id), to: String(to._id) }], actor, requestId, session });
  }
  for (const type of roomTypes.values()) await type.save({ session });
  reservation.updated_by = actor;
  await reservation.save({ session });
  return reservation;
}

// Client room arrays must not forge or erase server-owned move metadata.
function preserveAssignmentMetadata(before, record) {
  for (const line of record.rooms) {
    const previous = before.rooms.find((item) => String(item._id) === String(line._id));
    line.current_assignment_from = previous?.current_assignment_from;
  }
  if (before.status !== "checked_in") return;
  if (before.rooms.length !== record.rooms.length || before.rooms.some((previous) => !record.rooms.some((line) =>
    String(line._id) === String(previous._id) && String(line.room_type_id) === String(previous.room_type_id) && String(line.physical_room_id || "") === String(previous.physical_room_id || "")
  ))) throw error(409, "Use Move room on the reservation details to change an in-house room assignment.");
  if (+new Date(before.check_in) !== +record.check_in || Boolean(before.is_day_room) !== record.is_day_room) throw error(409, "The arrival date and stay type cannot be changed after check-in.");
  if (record.rooms.some((line) => line.current_assignment_from && inventoryDay(line.current_assignment_from) >= inventoryRange(record).end)) {
    throw error(409, "Check-out cannot be before the current room assignment. Review the departure date.");
  }
}

module.exports = { moveInHouseRooms, preserveAssignmentMetadata };
