const express = require("express");
const mongoose = require("mongoose");
const CrossBooking = require("../db_models/crossbooking.model");
const Reservation = require("../db_models/booking.model");
const { ACTIVE_RESERVATION_STATUSES } = require("../db_models/booking.model");
const RoomType = require("../db_models/rooms.model");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };

  if (req.query.active === "true") query.active = true;
  if (req.query.active === "false") query.active = false;

  const roomId = String(req.query.room_id || "").trim();
  if (roomId) {
    if (!mongoose.isValidObjectId(roomId)) {
      throw badRequest("room_id must be a valid physical room ID.");
    }
    query.$or = [{ room_a_id: roomId }, { room_b_id: roomId }];
  }

  const links = await CrossBooking.find(query).sort({
    room_a_number: 1,
    room_b_number: 1,
    _id: 1
  });

  return res.status(200).json({
    count: links.length,
    cross_bookings: links
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const roomAId = roomIdFrom(req.body, "room_a_id", "primary_room_id");
  const roomBId = roomIdFrom(req.body, "room_b_id", "blocked_room_id");

  if (!roomAId || !roomBId) {
    throw badRequest("room_a_id and room_b_id are required.");
  }
  if (!mongoose.isValidObjectId(roomAId) || !mongoose.isValidObjectId(roomBId)) {
    throw badRequest("Both physical room IDs must be valid MongoDB ObjectIds.");
  }
  if (roomAId === roomBId) {
    throw badRequest("A room cannot be cross-booked with itself.");
  }

  const [roomA, roomB] = await Promise.all([
    resolvePhysicalRoom(propertyId, roomAId),
    resolvePhysicalRoom(propertyId, roomBId)
  ]);
  if (!roomA || !roomB) {
    throw notFound("One or both physical rooms do not exist or are disabled.");
  }

  const active = req.body?.active !== false;
  if (active) {
    await ensurePairHasNoExistingReservationConflict(
      propertyId,
      roomA.physical_room._id,
      roomB.physical_room._id
    );
  }

  const actor = actorFromRequest(req);
  const link = new CrossBooking({
    property_id: propertyId,
    room_a_id: roomA.physical_room._id,
    room_b_id: roomB.physical_room._id,
    room_a_number: roomA.physical_room.room_number,
    room_b_number: roomB.physical_room.room_number,
    room_a_type_id: roomA.room_type._id,
    room_b_type_id: roomB.room_type._id,
    room_a_type_name: roomA.room_type.name,
    room_b_type_name: roomB.room_type.name,
    active,
    created_by: actor,
    updated_by: actor
  });
  await link.save();

  return res.status(201).json({
    message: "Cross-booking relationship created successfully.",
    cross_booking: link
  });
}));

router.get("/:crossBookingId", asyncHandler(async (req, res) => {
  const link = await findCrossBooking(req);
  if (!link) throw notFound("Cross-booking relationship not found.");
  return res.status(200).json({ cross_booking: link });
}));

router.patch("/:crossBookingId", asyncHandler(async (req, res) => {
  const link = await findCrossBooking(req);
  if (!link) throw notFound("Cross-booking relationship not found.");

  if (!Object.prototype.hasOwnProperty.call(req.body || {}, "active")) {
    throw badRequest("Only the active field can be changed. Delete and recreate a link to change its rooms.");
  }
  if (typeof req.body.active !== "boolean") {
    throw badRequest("active must be true or false.");
  }

  if (req.body.active && !link.active) {
    const [roomA, roomB] = await Promise.all([
      resolvePhysicalRoom(link.property_id, link.room_a_id),
      resolvePhysicalRoom(link.property_id, link.room_b_id)
    ]);
    if (!roomA || !roomB) {
      throw conflict("Both physical rooms must exist and be enabled before this link can be activated.");
    }
    await ensurePairHasNoExistingReservationConflict(
      link.property_id,
      link.room_a_id,
      link.room_b_id
    );
  }

  link.active = req.body.active;
  link.updated_by = actorFromRequest(req);
  await link.save();

  return res.status(200).json({
    message: `Cross-booking relationship ${link.active ? "activated" : "disabled"} successfully.`,
    cross_booking: link
  });
}));

router.delete("/:crossBookingId", asyncHandler(async (req, res) => {
  const link = await findCrossBooking(req);
  if (!link) throw notFound("Cross-booking relationship not found.");

  await link.deleteOne();
  return res.status(200).json({
    message: "Cross-booking relationship deleted successfully."
  });
}));

router.use((error, _req, res, _next) => {
  if (error.code === 11000) {
    return res.status(409).json({
      message: "These physical rooms are already cross-booked for this property."
    });
  }
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError ||
    error.name === "BSONError"
  ) {
    return res.status(400).json({
      message: "Cross-booking validation failed.",
      errors: Object.values(error.errors || {}).map(
        (validationError) => validationError.message
      )
    });
  }
  if (error instanceof mongoose.Error.VersionError) {
    return res.status(409).json({
      message: "This relationship was changed by another request. Reload it and try again."
    });
  }
  if (error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  console.error(error);
  return res.status(500).json({
    message: "The cross-booking request could not be completed."
  });
});

async function resolvePhysicalRoom(propertyId, physicalRoomId) {
  const roomType = await RoomType.findOne({
    property_id: propertyId,
    active: true,
    physical_rooms: {
      $elemMatch: { _id: physicalRoomId, active: true }
    }
  });
  if (!roomType) return null;
  return {
    room_type: roomType,
    physical_room: roomType.physical_rooms.id(physicalRoomId)
  };
}

async function ensurePairHasNoExistingReservationConflict(
  propertyId,
  roomAId,
  roomBId
) {
  const reservations = await Reservation.find(
    {
      property_id: propertyId,
      status: { $in: ACTIVE_RESERVATION_STATUSES },
      deleted_at: { $exists: false },
      rooms: {
        $elemMatch: { physical_room_id: { $in: [roomAId, roomBId] } }
      }
    },
    { reservation_no: 1, check_in: 1, check_out: 1, rooms: 1 }
  );

  const roomAReservations = reservations.filter((reservation) =>
    reservation.rooms.some(
      (room) => String(room.physical_room_id || "") === String(roomAId)
    )
  );
  const roomBReservations = reservations.filter((reservation) =>
    reservation.rooms.some(
      (room) => String(room.physical_room_id || "") === String(roomBId)
    )
  );

  const overlap = roomAReservations.find((first) =>
    roomBReservations.some(
      (second) => first.check_in < second.check_out && first.check_out > second.check_in
    )
  );
  if (overlap) {
    throw conflict(
      "These rooms already have overlapping active reservations and cannot be linked."
    );
  }
}

async function findCrossBooking(req) {
  if (!mongoose.isValidObjectId(req.params.crossBookingId)) return null;
  const propertyId = requirePropertyId(req);
  return CrossBooking.findOne({
    _id: req.params.crossBookingId,
    property_id: propertyId
  });
}

function roomIdFrom(payload, primaryField, aliasField) {
  return String(payload?.[primaryField] || payload?.[aliasField] || "").trim();
}

function requirePropertyId(req) {
  const propertyId = String(
    req.query.property_id ||
    req.get("x-property-id") ||
    req.body?.property_id ||
    ""
  ).trim();
  if (!propertyId) {
    throw badRequest(
      "property_id is required in the query, request body, or x-property-id header."
    );
  }
  return propertyId;
}

function actorFromRequest(req) {
  return String(req.get("x-user-name") || "System").trim() || "System";
}

function badRequest(message) {
  return httpError(400, message);
}

function notFound(message) {
  return httpError(404, message);
}

function conflict(message) {
  return httpError(409, message);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = router;
