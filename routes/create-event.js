const express = require("express");
const mongoose = require("mongoose");
const CreateEvent = require("../db_models/create-event.model");

const router = express.Router();
const EVENT_FIELDS = [
  "title",
  "venue",
  "event_date",
  "start_time",
  "end_time",
  "owner",
  "status",
  "description"
];

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };

  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { title: pattern },
      { venue: pattern },
      { owner: pattern },
      { description: pattern }
    ];
  }

  const venue = String(req.query.venue || "").trim();
  if (venue && venue.toLowerCase() !== "all venues") {
    query.venue_key = venue.toLowerCase();
  }

  const status = normalizeStatus(req.query.status);
  if (status && status !== "all") query.status = status;

  applyDateFilter(query, req.query);

  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 100), 200);
  const skip = (page - 1) * limit;

  const [events, total] = await Promise.all([
    CreateEvent.find(query)
      .sort({ event_date: 1, start_time: 1, venue: 1, _id: 1 })
      .skip(skip)
      .limit(limit),
    CreateEvent.countDocuments(query)
  ]);

  return res.status(200).json({
    count: events.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    events
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const event = new CreateEvent({
    property_id: propertyId,
    created_by: actor,
    updated_by: actor
  });

  applyEventPayload(event, req.body || {});
  await event.validate();
  await ensureVenueIsAvailable(event);
  await event.save();

  return res.status(201).json({
    message: "Event created successfully.",
    event
  });
}));

router.get("/:eventId", asyncHandler(async (req, res) => {
  const event = await findEvent(req);
  if (!event) {
    return res.status(404).json({ message: "Event not found." });
  }

  return res.status(200).json({ event });
}));

router.patch("/:eventId", asyncHandler(async (req, res) => {
  const event = await findEvent(req);
  if (!event) {
    return res.status(404).json({ message: "Event not found." });
  }

  applyEventPayload(event, req.body || {});
  event.updated_by = actorFromRequest(req);
  await event.validate();
  await ensureVenueIsAvailable(event);
  await event.save();

  return res.status(200).json({
    message: "Event updated successfully.",
    event
  });
}));

router.delete("/:eventId", asyncHandler(async (req, res) => {
  const event = await findEvent(req);
  if (!event) {
    return res.status(404).json({ message: "Event not found." });
  }

  await event.deleteOne();
  return res.status(200).json({
    message: "Event deleted successfully."
  });
}));

router.use((error, _req, res, _next) => {
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError ||
    error.name === "BSONError"
  ) {
    return res.status(400).json({
      message: "Event validation failed.",
      errors: Object.values(error.errors || {}).map(
        (validationError) => validationError.message
      )
    });
  }
  if (error instanceof mongoose.Error.VersionError) {
    return res.status(409).json({
      message: "This event was changed by another request. Reload it and try again."
    });
  }
  if (error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  console.error(error);
  return res.status(500).json({
    message: "The event request could not be completed."
  });
});

async function ensureVenueIsAvailable(event) {
  const conflict = await CreateEvent.findOne({
    _id: { $ne: event._id },
    property_id: event.property_id,
    venue_key: event.venue_key,
    event_date: event.event_date,
    start_time: { $lt: event.end_time },
    end_time: { $gt: event.start_time }
  }).select("title venue event_date start_time end_time");

  if (conflict) {
    const error = new Error(
      `${event.venue} is already booked from ${conflict.start_time} to ${conflict.end_time} for "${conflict.title}".`
    );
    error.statusCode = 409;
    throw error;
  }
}

async function findEvent(req) {
  if (!mongoose.isValidObjectId(req.params.eventId)) return null;
  const propertyId = requirePropertyId(req);
  return CreateEvent.findOne({
    _id: req.params.eventId,
    property_id: propertyId
  });
}

function applyEventPayload(event, payload) {
  const normalizedPayload = {
    ...payload,
    event_date: payload.event_date ?? payload.date,
    start_time: payload.start_time ?? payload.start,
    end_time: payload.end_time ?? payload.end
  };

  EVENT_FIELDS.forEach((field) => {
    if (
      Object.prototype.hasOwnProperty.call(normalizedPayload, field) &&
      normalizedPayload[field] !== undefined
    ) {
      event[field] =
        field === "status"
          ? normalizeStatus(normalizedPayload[field])
          : normalizedPayload[field];
    }
  });
}

function applyDateFilter(query, params) {
  if (!params.date_from && !params.date_to) return;
  query.event_date = {};
  if (params.date_from) query.event_date.$gte = parseDateOnly(params.date_from);
  if (params.date_to) query.event_date.$lte = parseDateOnly(params.date_to);
}

function requirePropertyId(req) {
  const propertyId = getPropertyId(req);
  if (!propertyId) {
    const error = new Error(
      "property_id is required in the query, request body, or x-property-id header."
    );
    error.statusCode = 400;
    throw error;
  }
  return propertyId;
}

function getPropertyId(req) {
  return String(
    req.query.property_id ||
    req.get("x-property-id") ||
    req.body?.property_id ||
    ""
  ).trim();
}

function actorFromRequest(req) {
  return String(
    req.get("x-user-name") ||
    req.body?.updated_by ||
    req.body?.created_by ||
    ""
  ).trim();
}

function parseDateOnly(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`Invalid event date: ${value}`);
    error.statusCode = 400;
    throw error;
  }
  return date;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = router;
