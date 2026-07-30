const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const {
  ACTIVE_RESERVATION_STATUSES
} = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");
const RoomType = require("../db_models/rooms.model");

async function validateReservationInventory({
  propertyId,
  checkIn,
  checkOut,
  rooms,
  excludeReservationId,
  linkedBusinessBlockId,
  session
}) {
  const roomTypeIds = uniqueIds(rooms.map((room) => room.room_type_id));
  const roomTypes = await RoomType.find({
    property_id: propertyId,
    _id: { $in: roomTypeIds },
    active: true
  }).session(session || null);

  if (roomTypes.length !== roomTypeIds.length) {
    throw conflict("One or more selected room types do not exist or are disabled.");
  }

  const roomTypeMap = new Map(roomTypes.map((roomType) => [String(roomType._id), roomType]));
  const requestedByType = new Map();

  for (const room of rooms) {
    const roomType = roomTypeMap.get(String(room.room_type_id));
    if (!roomType) continue;

    room.room_type_name = roomType.name;
    if (room.adults > roomType.maximum_adults) {
      throw conflict(
        `${roomType.name} allows at most ${roomType.maximum_adults} adult(s).`
      );
    }
    if (room.children > roomType.maximum_children) {
      throw conflict(
        `${roomType.name} allows at most ${roomType.maximum_children} child(ren).`
      );
    }

    requestedByType.set(
      String(roomType._id),
      (requestedByType.get(String(roomType._id)) || 0) + 1
    );

    if (!room.physical_room_id) {
      room.room_number = "";
      continue;
    }

    const physicalRoom = roomType.physical_rooms.id(room.physical_room_id);
    if (!physicalRoom || !physicalRoom.active) {
      throw conflict(`The selected physical room for ${roomType.name} is unavailable.`);
    }
    room.room_number = physicalRoom.room_number;

    const overlapQuery = overlapReservationQuery({
      propertyId,
      checkIn,
      checkOut,
      excludeReservationId
    });
    overlapQuery.rooms = {
      $elemMatch: { physical_room_id: physicalRoom._id }
    };
    if (await Reservation.exists(overlapQuery).session(session || null)) {
      throw conflict(
        `Physical room ${physicalRoom.room_number} is already assigned during these dates.`
      );
    }
  }

  const overlappingReservations = await Reservation.find(
    overlapReservationQuery({
      propertyId,
      checkIn,
      checkOut,
      excludeReservationId
    }),
    { rooms: 1, business_block_id: 1 }
  ).session(session || null);

  const usedByType = new Map();
  const pickedByAllocation = new Map();
  for (const reservation of overlappingReservations) {
    for (const room of reservation.rooms) {
      if (room.business_block_allocation_id) {
        const allocationId = String(room.business_block_allocation_id);
        pickedByAllocation.set(
          allocationId,
          (pickedByAllocation.get(allocationId) || 0) + 1
        );
      }
      if (
        linkedBusinessBlockId &&
        String(reservation.business_block_id || "") === String(linkedBusinessBlockId)
      ) {
        continue;
      }
      const typeId = String(room.room_type_id);
      usedByType.set(typeId, (usedByType.get(typeId) || 0) + 1);
    }
  }

  const blockQuery = {
    property_id: propertyId,
    status: "active",
    deleted_at: { $exists: false },
    check_in: { $lt: checkOut },
    check_out: { $gt: checkIn }
  };
  if (linkedBusinessBlockId) blockQuery._id = { $ne: linkedBusinessBlockId };

  const activeBlocks = await BusinessBlock.find(blockQuery, {
    allocations: 1
  }).session(session || null);
  const heldByType = new Map();
  for (const block of activeBlocks) {
    for (const allocation of block.allocations) {
      const picked = pickedByAllocation.get(String(allocation._id)) || 0;
      const remainingHold = Math.max(
        allocation.quantity - allocation.released_quantity - picked,
        0
      );
      const typeId = String(allocation.room_type_id);
      heldByType.set(typeId, (heldByType.get(typeId) || 0) + remainingHold);
    }
  }

  for (const [typeId, requested] of requestedByType) {
    const roomType = roomTypeMap.get(typeId);
    const physicalCount = roomType.physical_rooms.filter(
      (room) =>
        room.active &&
        !["out_of_order", "maintenance"].includes(room.operational_status)
    ).length;
    const used = usedByType.get(typeId) || 0;
    const held = heldByType.get(typeId) || 0;
    const available = Math.max(physicalCount - used - held, 0);
    if (requested > available) {
      throw conflict(
        `${roomType.name} has only ${available} sellable room(s) available for these dates.`
      );
    }
  }
}

async function validateBusinessBlockInventory({
  block,
  excludeBlockId,
  session
}) {
  const requestedRooms = block.allocations.flatMap((allocation) =>
    Array.from({ length: allocation.quantity }, () => ({
      room_type_id: allocation.room_type_id,
      adults: 1,
      children: 0
    }))
  );
  await validateReservationInventory({
    propertyId: block.property_id,
    checkIn: block.check_in,
    checkOut: block.check_out,
    rooms: requestedRooms,
    linkedBusinessBlockId: excludeBlockId || block._id,
    session
  });
}

async function getBusinessBlockMetrics(block, { session } = {}) {
  const reservations = await Reservation.find({
    property_id: block.property_id,
    business_block_id: block._id,
    status: { $nin: ["cancelled", "no_show"] },
    deleted_at: { $exists: false }
  }, { rooms: 1 }).session(session || null);

  const pickedByAllocation = new Map();
  for (const reservation of reservations) {
    for (const room of reservation.rooms) {
      if (!room.business_block_allocation_id) continue;
      const key = String(room.business_block_allocation_id);
      pickedByAllocation.set(key, (pickedByAllocation.get(key) || 0) + 1);
    }
  }

  const nights = Math.max(
    1,
    Math.ceil((block.check_out - block.check_in) / 86_400_000)
  );
  const allocations = block.allocations.map((allocation) => {
    const picked = pickedByAllocation.get(String(allocation._id)) || 0;
    const blocked = allocation.quantity;
    const released = allocation.released_quantity;
    const remaining = Math.max(blocked - picked - released, 0);
    return {
      allocation_id: allocation._id,
      room_type_id: allocation.room_type_id,
      blocked,
      picked,
      released,
      remaining,
      estimated_value: blocked * allocation.negotiated_rate * nights
    };
  });

  return {
    blocked: sum(allocations, "blocked"),
    picked: sum(allocations, "picked"),
    released: sum(allocations, "released"),
    remaining: sum(allocations, "remaining"),
    estimated_value: sum(allocations, "estimated_value"),
    balance: Math.max(
      sum(allocations, "estimated_value") - block.billing.deposit_paid,
      0
    ),
    allocations
  };
}

async function occupyAssignedRooms(reservation, { session } = {}) {
  for (const roomLine of reservation.rooms) {
    if (!roomLine.physical_room_id) {
      throw conflict(
        `Assign a physical room to ${roomLine.room_type_name} before check-in.`
      );
    }
    const roomType = await RoomType.findOne({
      _id: roomLine.room_type_id,
      property_id: reservation.property_id
    }).session(session || null);
    const physicalRoom = roomType?.physical_rooms.id(roomLine.physical_room_id);
    if (!physicalRoom || !physicalRoom.active) {
      throw conflict(`Physical room ${roomLine.room_number || ""} is unavailable.`);
    }
    if (physicalRoom.operational_status !== "available") {
      throw conflict(
        `Physical room ${physicalRoom.room_number} is ${physicalRoom.operational_status}.`
      );
    }
    if (!["clean", "inspected"].includes(physicalRoom.housekeeping_status)) {
      throw conflict(
        `Physical room ${physicalRoom.room_number} must be clean before check-in.`
      );
    }
    physicalRoom.operational_status = "occupied";
    await roomType.save({ session });
  }
}

async function releaseAssignedRoomsAfterCheckout(reservation, { session } = {}) {
  for (const roomLine of reservation.rooms) {
    if (!roomLine.physical_room_id) continue;
    const roomType = await RoomType.findOne({
      _id: roomLine.room_type_id,
      property_id: reservation.property_id
    }).session(session || null);
    const physicalRoom = roomType?.physical_rooms.id(roomLine.physical_room_id);
    if (!physicalRoom) continue;
    physicalRoom.operational_status = "available";
    physicalRoom.housekeeping_status = "dirty";
    await roomType.save({ session });
  }
}

function overlapReservationQuery({
  propertyId,
  checkIn,
  checkOut,
  excludeReservationId
}) {
  const query = {
    property_id: propertyId,
    status: { $in: ACTIVE_RESERVATION_STATUSES },
    deleted_at: { $exists: false },
    check_in: { $lt: checkOut },
    check_out: { $gt: checkIn }
  };
  if (excludeReservationId) query._id = { $ne: excludeReservationId };
  return query;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function uniqueIds(values) {
  return [...new Set(values.filter(Boolean).map(String))].map(
    (value) => new mongoose.Types.ObjectId(value)
  );
}

function sum(items, key) {
  return items.reduce((total, item) => total + item[key], 0);
}

module.exports = {
  getBusinessBlockMetrics,
  occupyAssignedRooms,
  releaseAssignedRoomsAfterCheckout,
  validateBusinessBlockInventory,
  validateReservationInventory
};
