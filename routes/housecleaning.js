const express = require("express");
const mongoose = require("mongoose");
const RoomType = require("../db_models/rooms.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const {
  HousekeepingTask,
  HousekeepingAttendant,
  HousekeepingActivity
} = require("../db_models/housecleaning.model");
const {
  actorFromRequest,
  changesFromPayload,
  writeAuditLog
} = require("../services/booking-audit.service");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const activityLimit = Math.min(positiveInteger(req.query.activity_limit, 500), 1000);
  const [roomTypes, tasks, attendants, activities] = await Promise.all([
    RoomType.find({ property_id: propertyId, active: true }).sort({ name: 1 }),
    HousekeepingTask.find({ property_id: propertyId }).sort({ priority: -1, updated_at: -1 }),
    HousekeepingAttendant.find({ property_id: propertyId }).sort({ status: 1, name: 1 }),
    HousekeepingActivity.find({ property_id: propertyId }).sort({ created_at: -1 }).limit(activityLimit)
  ]);
  const taskByRoom = new Map(tasks.map((task) => [String(task.physical_room_id), task]));

  return res.status(200).json({
    property_id: propertyId,
    rooms: roomTypes.flatMap((roomType) => roomType.physical_rooms
      .filter((room) => room.active)
      .map((room) => serializeRoom(roomType, room, taskByRoom.get(String(room._id))))),
    attendants,
    activities
  });
}));

router.get("/activities", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };
  if (req.query.physical_room_id) {
    query.physical_room_id = objectId(req.query.physical_room_id, "physical_room_id");
  }
  const limit = Math.min(positiveInteger(req.query.limit, 500), 1000);
  const activities = await HousekeepingActivity.find(query).sort({ created_at: -1 }).limit(limit);
  return res.status(200).json({ count: activities.length, activities });
}));

router.get("/audit-log", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId, entity_type: "housekeeping_task" };
  if (req.query.task_id) query.entity_id = objectId(req.query.task_id, "task_id");
  const logs = await BookingAuditLog.find(query).sort({ created_at: -1 }).limit(1000);
  return res.status(200).json({ count: logs.length, logs });
}));

router.post("/attendants", asyncHandler(async (req, res) => {
  const attendant = new HousekeepingAttendant({
    property_id: requirePropertyId(req),
    employee_number: req.body?.employee_number,
    name: req.body?.name,
    department: req.body?.department || "Housekeeping",
    status: req.body?.status || "active",
    phone: req.body?.phone || "",
    email: req.body?.email || "",
    joined_at: req.body?.joined_at || new Date(),
    updated_by: actorFromRequest(req)
  });
  await attendant.save();
  return res.status(201).json({ message: "Housekeeping attendant created successfully.", attendant });
}));

router.patch("/attendants/:attendantId", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const attendant = await requireAttendant(req.params.attendantId, propertyId);
  if (req.body?.version !== undefined && Number(req.body.version) !== attendant.version) {
    throw httpError(409, "This attendant has changed. Reload and try again.");
  }
  for (const field of ["employee_number", "name", "department", "status", "phone", "email", "joined_at"]) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) attendant[field] = req.body[field];
  }
  attendant.updated_by = actorFromRequest(req);
  await attendant.save();
  return res.status(200).json({ message: "Housekeeping attendant updated successfully.", attendant });
}));

router.post("/rooms/:physicalRoomId/assign", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const attendantId = objectId(req.body?.attendant_id, "attendant_id");
  const result = await mutateRoomTask(req, propertyId, async ({ roomType, room, task, actor, session }) => {
    assertRoomCanBeServiced(room);
    const attendant = await requireAttendant(attendantId, propertyId, session);
    if (attendant.status !== "active") throw httpError(409, "Only an active attendant can be assigned.");
    const before = task.toObject();
    task.attendant = attendantSnapshot(attendant);
    task.priority = normalizePriority(req.body?.priority || task.priority);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "notes")) task.notes = req.body.notes;
    if (["completed", "inspected"].includes(task.status)) task.status = "assigned";
    task.assigned_at = new Date();
    task.updated_by = actor;
    await task.save({ session });
    await recordAction({
      req, propertyId, roomType, room, task, actor, session,
      action: "assigned", fromStatus: before.status || "", toStatus: task.status,
      description: `Room ${room.room_number} was assigned to ${attendant.name}.`,
      changes: changesFromPayload(before, task.toObject(), ["status", "priority", "attendant", "notes"])
    });
    return task;
  });
  return res.status(200).json({ message: "Room assigned successfully.", ...result });
}));

router.post("/rooms/:physicalRoomId/start", asyncHandler(async (req, res) => {
  const result = await mutateRoomTask(req, requirePropertyId(req), async ({ roomType, room, task, actor, session, propertyId }) => {
    assertRoomCanBeServiced(room);
    if (!["dirty", "clean"].includes(room.housekeeping_status)) {
      throw httpError(409, `Room ${room.room_number} cannot start cleaning from ${room.housekeeping_status}.`);
    }
    const before = task.toObject();
    const previousRoomStatus = room.housekeeping_status;
    room.housekeeping_status = "in_progress";
    task.status = "in_progress";
    task.started_at = new Date();
    task.completed_at = null;
    task.inspected_at = null;
    task.updated_by = actor;
    await roomType.save({ session });
    await task.save({ session });
    await recordAction({
      req, propertyId, roomType, room, task, actor, session,
      action: "cleaning_started", fromStatus: previousRoomStatus, toStatus: "in_progress",
      description: `Cleaning started for room ${room.room_number}.`,
      changes: changesFromPayload(before, task.toObject(), ["status", "started_at"])
    });
    return task;
  });
  return res.status(200).json({ message: "Cleaning started successfully.", ...result });
}));

router.post("/rooms/:physicalRoomId/complete", asyncHandler(async (req, res) => {
  const result = await mutateRoomTask(req, requirePropertyId(req), async ({ roomType, room, task, actor, session, propertyId }) => {
    assertRoomCanBeServiced(room);
    if (room.housekeeping_status !== "in_progress") {
      throw httpError(409, `Room ${room.room_number} must be in progress before it can be completed.`);
    }
    const before = task.toObject();
    room.housekeeping_status = "clean";
    task.status = "completed";
    task.completed_at = new Date();
    task.updated_by = actor;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "notes")) task.notes = req.body.notes;
    await roomType.save({ session });
    await task.save({ session });
    await recordAction({
      req, propertyId, roomType, room, task, actor, session,
      action: "cleaning_completed", fromStatus: "in_progress", toStatus: "clean",
      description: `Cleaning completed for room ${room.room_number}.`,
      changes: changesFromPayload(before, task.toObject(), ["status", "completed_at", "notes"])
    });
    return task;
  });
  return res.status(200).json({ message: "Cleaning completed successfully.", ...result });
}));

router.post("/rooms/:physicalRoomId/inspect", asyncHandler(async (req, res) => {
  const result = await mutateRoomTask(req, requirePropertyId(req), async ({ roomType, room, task, actor, session, propertyId }) => {
    assertRoomCanBeServiced(room);
    if (room.housekeeping_status !== "clean" || task.status !== "completed") {
      throw httpError(409, `Room ${room.room_number} must be cleaned before inspection.`);
    }
    const before = task.toObject();
    room.housekeeping_status = "inspected";
    task.status = "inspected";
    task.inspected_at = new Date();
    task.updated_by = actor;
    await roomType.save({ session });
    await task.save({ session });
    await recordAction({
      req, propertyId, roomType, room, task, actor, session,
      action: "inspection_completed", fromStatus: "clean", toStatus: "inspected",
      description: `Room ${room.room_number} passed housekeeping inspection.`,
      changes: changesFromPayload(before, task.toObject(), ["status", "inspected_at"])
    });
    return task;
  });
  return res.status(200).json({ message: "Room inspection completed successfully.", ...result });
}));

router.use((error, _req, res, _next) => {
  if (error.status) return res.status(error.status).json({ message: error.message });
  if (error.code === 11000) return res.status(409).json({ message: "That housekeeping record already exists." });
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
    return res.status(400).json({
      message: "Housekeeping validation failed.",
      errors: Object.values(error.errors || {}).map((item) => item.message)
    });
  }
  if (error instanceof mongoose.Error.VersionError) {
    return res.status(409).json({ message: "This housekeeping record changed. Reload and try again." });
  }
  console.error(error);
  return res.status(500).json({ message: "The housekeeping request could not be completed." });
});

async function mutateRoomTask(req, propertyId, mutation) {
  return inTransaction(async (session) => {
    const { roomType, room } = await requirePhysicalRoom(req.params.physicalRoomId, propertyId, session);
    let task = await HousekeepingTask.findOne({ property_id: propertyId, physical_room_id: room._id }).session(session);
    if (!task) {
      task = new HousekeepingTask({
        property_id: propertyId,
        physical_room_id: room._id,
        room_type_id: roomType._id,
        room_number: room.room_number,
        room_type_name: roomType.name
      });
    } else {
      task.room_number = room.room_number;
      task.room_type_name = roomType.name;
      task.room_type_id = roomType._id;
    }
    const actor = actorFromRequest(req);
    await mutation({ propertyId, roomType, room, task, actor, session });
    return { room: serializeRoom(roomType, room, task), task };
  });
}

async function recordAction({ req, propertyId, roomType, room, task, actor, session, action, fromStatus, toStatus, description, changes }) {
  await HousekeepingActivity.create([{
    property_id: propertyId,
    physical_room_id: room._id,
    room_type_id: roomType._id,
    task_id: task._id,
    room_number: room.room_number,
    room_type_name: roomType.name,
    action,
    from_status: fromStatus,
    to_status: toStatus,
    attendant: task.attendant,
    notes: task.notes,
    actor,
    request_id: requestId(req)
  }], { session });
  await writeAuditLog({
    propertyId,
    entityType: "housekeeping_task",
    entityId: task._id,
    action: `housekeeping_${action}`,
    description,
    actor,
    changes,
    requestId: requestId(req),
    session
  });
}

function serializeRoom(roomType, room, task) {
  return {
    physical_room_id: room._id,
    room_type_id: roomType._id,
    room_number: room.room_number,
    room_type_name: roomType.name,
    floor: room.floor,
    operational_status: room.operational_status,
    housekeeping_status: room.housekeeping_status,
    active: room.active,
    task: task || null
  };
}

async function requirePhysicalRoom(id, propertyId, session) {
  const physicalRoomId = objectId(id, "physicalRoomId");
  const query = RoomType.findOne({ property_id: propertyId, "physical_rooms._id": physicalRoomId });
  if (session) query.session(session);
  const roomType = await query;
  const room = roomType?.physical_rooms.id(physicalRoomId);
  if (!room || !room.active) throw httpError(404, "Physical room not found.");
  return { roomType, room };
}

async function requireAttendant(id, propertyId, session = null) {
  const attendantId = objectId(id, "attendant_id");
  const query = HousekeepingAttendant.findOne({ _id: attendantId, property_id: propertyId });
  if (session) query.session(session);
  const attendant = await query;
  if (!attendant) throw httpError(404, "Housekeeping attendant not found.");
  return attendant;
}

function assertRoomCanBeServiced(room) {
  if (room.operational_status === "occupied") throw httpError(409, `Room ${room.room_number} is occupied.`);
  if (["maintenance", "out_of_order"].includes(room.operational_status)) {
    throw httpError(409, `Room ${room.room_number} is ${room.operational_status.replaceAll("_", " ")}.`);
  }
}

function attendantSnapshot(attendant) {
  return { attendant_id: attendant._id, employee_number: attendant.employee_number, name: attendant.name };
}

function normalizePriority(value) {
  const priority = String(value || "normal").trim().toLowerCase();
  if (!["low", "normal", "high", "urgent"].includes(priority)) {
    throw httpError(400, "priority must be low, normal, high, or urgent.");
  }
  return priority;
}

function requirePropertyId(req) {
  const propertyId = String(req.get("x-property-id") || req.query.property_id || req.body?.property_id || "").trim();
  if (!propertyId) throw httpError(400, "property_id is required.");
  return propertyId;
}

function objectId(value, field) {
  if (!mongoose.isValidObjectId(value)) throw httpError(400, `${field} must be a valid MongoDB ObjectId.`);
  return new mongoose.Types.ObjectId(value);
}

function requestId(req) {
  return String(req.get("x-request-id") || "").trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = router;
