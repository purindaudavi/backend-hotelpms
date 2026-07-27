const express = require("express");
const mongoose = require("mongoose");
const RoomType = require("../db_models/rooms.model");

const router = express.Router();
const imageBodyParser = express.raw({
  type: ["image/jpeg", "image/png", "image/webp"],
  limit: "5mb"
});

const ROOM_TYPE_FIELDS = [
  "property_id",
  "name",
  "maximum_adults",
  "maximum_children",
  "base_rate",
  "currency",
  "description",
  "amenities",
  "active"
];

const PHYSICAL_ROOM_FIELDS = [
  "room_number",
  "floor",
  "operational_status",
  "housekeeping_status",
  "active",
  "notes"
];

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = getPropertyId(req);
  if (!propertyId) {
    return res.status(400).json({
      message: "property_id is required as a query parameter or x-property-id header."
    });
  }

  const query = { property_id: propertyId };
  if (req.query.active === "true") query.active = true;
  if (req.query.active === "false") query.active = false;

  const roomTypes = await RoomType.find(query).sort({ name: 1 });
  return res.status(200).json({
    count: roomTypes.length,
    room_types: roomTypes.map((roomType) => serializeRoomType(roomType, req))
  });
}));

router.get("/physical-rooms", asyncHandler(async (req, res) => {
  const propertyId = getPropertyId(req);
  if (!propertyId) {
    return res.status(400).json({
      message: "property_id is required as a query parameter or x-property-id header."
    });
  }

  const roomTypes = await RoomType.find({ property_id: propertyId }).sort({ name: 1 });
  const physicalRooms = roomTypes.flatMap((roomType) => {
    const serialized = serializeRoomType(roomType, req);
    return serialized.physical_rooms;
  });

  return res.status(200).json({
    count: physicalRooms.length,
    physical_rooms: physicalRooms
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const payload = req.body || {};
  const roomType = new RoomType();
  applyRoomTypePayload(roomType, payload, { includePropertyId: true });

  if (
    Object.prototype.hasOwnProperty.call(payload, "physical_rooms") &&
    !Array.isArray(payload.physical_rooms)
  ) {
    return res.status(400).json({ message: "physical_rooms must be an array." });
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "amenities") &&
    !Array.isArray(payload.amenities)
  ) {
    return res.status(400).json({ message: "amenities must be an array." });
  }

  if (Array.isArray(payload.physical_rooms)) {
    roomType.physical_rooms = payload.physical_rooms.map(normalizePhysicalRoomPayload);
  }

  await roomType.save();
  return res.status(201).json({
    message: "Room type created successfully.",
    room_type: serializeRoomType(roomType, req)
  });
}));

router.get("/:roomTypeId", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  return res.status(200).json({
    room_type: serializeRoomType(roomType, req)
  });
}));

router.patch("/:roomTypeId", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  const payload = req.body || {};
  if (
    Object.prototype.hasOwnProperty.call(payload, "amenities") &&
    !Array.isArray(payload.amenities)
  ) {
    return res.status(400).json({ message: "amenities must be an array." });
  }

  applyRoomTypePayload(roomType, payload, { includePropertyId: false });
  await roomType.save();

  return res.status(200).json({
    message: "Room type updated successfully.",
    room_type: serializeRoomType(roomType, req)
  });
}));

router.delete("/:roomTypeId", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  const hasOccupiedRoom = roomType.physical_rooms.some(
    (room) => room.operational_status === "occupied"
  );
  if (hasOccupiedRoom && req.query.force !== "true") {
    return res.status(409).json({
      message: "This room type contains occupied rooms. Check them out or use force=true."
    });
  }

  const bucket = getImagesBucket();
  await Promise.all(
    roomType.images.map((image) => deleteGridFsFile(bucket, image.file_id))
  );
  await roomType.deleteOne();

  return res.status(200).json({ message: "Room type deleted successfully." });
}));

router.post("/:roomTypeId/physical-rooms", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  roomType.physical_rooms.push(normalizePhysicalRoomPayload(req.body || {}));
  await roomType.save();
  const physicalRoom = roomType.physical_rooms[roomType.physical_rooms.length - 1];

  return res.status(201).json({
    message: "Physical room created successfully.",
    physical_room: serializePhysicalRoom(roomType, physicalRoom)
  });
}));

router.patch("/:roomTypeId/physical-rooms/:physicalRoomId", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  const physicalRoom = roomType.physical_rooms.id(req.params.physicalRoomId);
  if (!physicalRoom) {
    return res.status(404).json({ message: "Physical room not found." });
  }

  applyPhysicalRoomPayload(physicalRoom, req.body || {});
  await roomType.save();

  return res.status(200).json({
    message: "Physical room updated successfully.",
    physical_room: serializePhysicalRoom(roomType, physicalRoom)
  });
}));

router.delete("/:roomTypeId/physical-rooms/:physicalRoomId", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  const physicalRoom = roomType.physical_rooms.id(req.params.physicalRoomId);
  if (!physicalRoom) {
    return res.status(404).json({ message: "Physical room not found." });
  }
  if (physicalRoom.operational_status === "occupied" && req.query.force !== "true") {
    return res.status(409).json({
      message: "An occupied physical room cannot be deleted. Check it out or use force=true."
    });
  }

  physicalRoom.deleteOne();
  await roomType.save();
  return res.status(200).json({ message: "Physical room deleted successfully." });
}));

router.post("/:roomTypeId/images", imageBodyParser, asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(415).json({
      message: "Send a JPEG, PNG, or WebP file as the raw request body."
    });
  }
  if (roomType.images.length >= 8) {
    return res.status(409).json({
      message: "A room type can contain at most 8 shared images."
    });
  }

  const contentType = req.get("content-type");
  const filename = safeFilename(req.get("x-file-name") || `room-${Date.now()}`);
  const altText = String(req.get("x-alt-text") || "").trim();
  const isPrimary =
    roomType.images.length === 0 ||
    String(req.get("x-primary-image")).toLowerCase() === "true";
  const bucket = getImagesBucket();
  const uploadedFile = await uploadGridFsFile(bucket, req.body, {
    filename,
    contentType,
    metadata: {
      property_id: roomType.property_id,
      room_type_id: roomType._id
    }
  });

  try {
    if (isPrimary) {
      roomType.images.forEach((image) => {
        image.is_primary = false;
      });
    }
    roomType.images.push({
      file_id: uploadedFile.id,
      filename,
      content_type: contentType,
      size: req.body.length,
      alt_text: altText,
      is_primary: isPrimary
    });
    await roomType.save();
  } catch (error) {
    await deleteGridFsFile(bucket, uploadedFile.id);
    throw error;
  }

  const image = roomType.images[roomType.images.length - 1];
  return res.status(201).json({
    message: "Shared room image uploaded successfully.",
    image: serializeImage(roomType, image, req)
  });
}));

router.get("/:roomTypeId/images/:imageId", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  const image = roomType.images.id(req.params.imageId);
  if (!image) {
    return res.status(404).json({ message: "Room image not found." });
  }

  res.set({
    "Content-Type": image.content_type,
    "Content-Length": image.size,
    "Cache-Control": "public, max-age=86400",
    "Content-Disposition": `inline; filename="${safeFilename(image.filename)}"`
  });

  const downloadStream = getImagesBucket().openDownloadStream(image.file_id);
  downloadStream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(error.code === "ENOENT" ? 404 : 500).json({
        message: error.code === "ENOENT" ? "Stored image file not found." : "Image could not be read."
      });
    } else {
      res.destroy(error);
    }
  });
  downloadStream.pipe(res);
}));

router.patch("/:roomTypeId/images/:imageId", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  const image = roomType.images.id(req.params.imageId);
  if (!image) {
    return res.status(404).json({ message: "Room image not found." });
  }

  const payload = req.body || {};
  if (Object.prototype.hasOwnProperty.call(payload, "alt_text")) {
    image.alt_text = String(payload.alt_text || "").trim();
  }
  if (payload.is_primary === true) {
    roomType.images.forEach((candidate) => {
      candidate.is_primary = candidate.id === image.id;
    });
  }

  await roomType.save();
  return res.status(200).json({
    message: "Room image updated successfully.",
    image: serializeImage(roomType, image, req)
  });
}));

router.delete("/:roomTypeId/images/:imageId", asyncHandler(async (req, res) => {
  const roomType = await findRoomType(req);
  if (!roomType) {
    return res.status(404).json({ message: "Room type not found." });
  }

  const image = roomType.images.id(req.params.imageId);
  if (!image) {
    return res.status(404).json({ message: "Room image not found." });
  }

  const fileId = image.file_id;
  const wasPrimary = image.is_primary;
  image.deleteOne();
  if (wasPrimary && roomType.images[0]) {
    roomType.images[0].is_primary = true;
  }
  await roomType.save();
  await deleteGridFsFile(getImagesBucket(), fileId);

  return res.status(200).json({ message: "Room image deleted successfully." });
}));

router.use((error, _req, res, _next) => {
  if (error.type === "entity.too.large") {
    return res.status(413).json({ message: "The image exceeds the 5 MB limit." });
  }
  if (error.code === 11000) {
    const duplicatedField = error.keyPattern?.slug
      ? "room type name"
      : error.keyPattern?.["physical_rooms.room_number"]
        ? "physical room number"
        : "unique value";
    return res.status(409).json({
      message: `That ${duplicatedField} already exists for this property.`
    });
  }
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError
  ) {
    return res.status(400).json({
      message: "Room data validation failed.",
      errors: Object.values(error.errors || {}).map((validationError) => validationError.message)
    });
  }
  if (error instanceof mongoose.Error.VersionError) {
    return res.status(409).json({
      message: "This room type was changed by another request. Reload it and try again."
    });
  }

  console.error(error);
  return res.status(500).json({ message: "The room request could not be completed." });
});

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getPropertyId(req) {
  return String(
    req.query.property_id ||
    req.get("x-property-id") ||
    req.body?.property_id ||
    ""
  ).trim();
}

async function findRoomType(req) {
  if (!mongoose.isValidObjectId(req.params.roomTypeId)) return null;
  const query = { _id: req.params.roomTypeId };
  const propertyId = getPropertyId(req);
  if (propertyId) query.property_id = propertyId;
  return RoomType.findOne(query);
}

function applyRoomTypePayload(roomType, payload, { includePropertyId }) {
  payload = payload || {};
  const fields = includePropertyId
    ? ROOM_TYPE_FIELDS
    : ROOM_TYPE_FIELDS.filter((field) => field !== "property_id");

  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      roomType[field] = payload[field];
    }
  });
}

function normalizePhysicalRoomPayload(payload) {
  const physicalRoom = {};
  applyPhysicalRoomPayload(physicalRoom, payload || {});
  return physicalRoom;
}

function applyPhysicalRoomPayload(physicalRoom, payload) {
  payload = payload || {};
  PHYSICAL_ROOM_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) return;
    const value =
      field === "operational_status" || field === "housekeeping_status"
        ? normalizeEnum(payload[field])
        : payload[field];
    physicalRoom[field] = value;
  });
}

function normalizeEnum(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function serializeRoomType(roomType, req) {
  const result = roomType.toObject({ virtuals: true });
  result.physical_rooms = roomType.physical_rooms.map((physicalRoom) =>
    serializePhysicalRoom(roomType, physicalRoom)
  );
  result.images = roomType.images.map((image) =>
    serializeImage(roomType, image, req)
  );
  return result;
}

function serializePhysicalRoom(roomType, physicalRoom) {
  return {
    ...physicalRoom.toObject(),
    room_type_id: roomType._id,
    room_type: roomType.name
  };
}

function serializeImage(roomType, image, req) {
  return {
    ...image.toObject(),
    url: `${req.protocol}://${req.get("host")}${req.baseUrl}/${roomType._id}/images/${image._id}`
  };
}

function getImagesBucket() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new Error("MongoDB is not connected.");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "room_type_images"
  });
}

function uploadGridFsFile(bucket, buffer, { filename, contentType, metadata }) {
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, {
      contentType,
      metadata
    });
    uploadStream.once("error", reject);
    uploadStream.once("finish", () => resolve({ id: uploadStream.id }));
    uploadStream.end(buffer);
  });
}

async function deleteGridFsFile(bucket, fileId) {
  try {
    await bucket.delete(fileId);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function safeFilename(value) {
  return String(value || "room-image")
    .replace(/[\r\n"]/g, "")
    .replace(/[\\/]/g, "-")
    .slice(0, 255);
}

module.exports = router;
