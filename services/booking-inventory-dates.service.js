const DAY_MS = 86_400_000;

function inventoryDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error("Please check the reservation dates and try again."), { statusCode: 400 });
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// This is an availability interval only, not a replacement for saved stay
// dates, charge units or overnight-night counts. Day use consumes its arrival
// date; normal stays consume arrival through the day before checkout.
function inventoryRange(record) {
  const start = inventoryDay(record.check_in);
  const end = record.is_day_room
    ? start + DAY_MS
    : Math.max(inventoryDay(record.check_out), start + DAY_MS);
  return { start, end };
}

function overlapsInventoryDates(first, second) {
  const a = inventoryRange(first);
  const b = inventoryRange(second);
  return a.start < b.end && a.end > b.start;
}

function reservationOverlapDateQuery(checkIn, checkOut) {
  const { start, end } = inventoryRange({ check_in: checkIn, check_out: checkOut });
  return {
    check_in: { $lt: new Date(end) },
    $or: [
      // A normal overnight checkout is exclusive. Missing legacy flags are
      // treated as ordinary overnight records, as elsewhere in the PMS.
      { is_day_room: { $ne: true }, check_out: { $gt: new Date(start) } },
      // A zero-night day-use booking has no later checkout to match against.
      // Its arrival date must fall inside the requested inventory interval.
      { is_day_room: true, check_in: { $gte: new Date(start) } }
    ]
  };
}

function physicalAssignments(reservation) {
  const range = inventoryRange(reservation);
  const assignments = [];
  for (const room of reservation.rooms || []) {
    if (!room.physical_room_id) continue;
    const start = room.current_assignment_from ? Math.max(range.start, inventoryDay(room.current_assignment_from)) : range.start;
    if (start < range.end) assignments.push({
      physical_room_id: room.physical_room_id, room_number: room.room_number,
      room_type_id: room.room_type_id, start, end: range.end
    });
  }
  for (const move of reservation.room_moves || []) {
    const start = Math.max(range.start, inventoryDay(move.previous_assigned_from));
    const end = Math.min(range.end, inventoryDay(move.business_date));
    if (start < end) assignments.push({
      physical_room_id: move.from_physical_room_id, room_number: move.from_room_number,
      room_type_id: move.room_type_id, start, end
    });
  }
  return assignments;
}

module.exports = { DAY_MS, inventoryDay, inventoryRange, overlapsInventoryDates, reservationOverlapDateQuery, physicalAssignments };
