const express = require("express");
const mongoose = require("mongoose");
const TravelAgent = require("../db_models/travel-agents.model");
const Reservation = require("../db_models/booking.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const {
  actorFromRequest,
  changesFromPayload,
  writeAuditLog
} = require("../services/booking-audit.service");

const router = express.Router();

const AGENT_FIELDS = [
  "name",
  "code",
  "contact_person",
  "agent_type",
  "email",
  "phone",
  "commission_percentage",
  "address",
  "vat_number",
  "status",
  "notes"
];

const PERFORMANCE_STATUSES = ["confirmed", "checked_in", "checked_out"];

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };
  const search = String(req.query.search || "").trim();
  const status = String(req.query.status || "").trim().toLowerCase();
  const agentType = normalizeAgentType(req.query.agent_type);

  if (status && status !== "all") query.status = status;
  if (req.query.active === "true") query.status = "active";
  if (req.query.active === "false") query.status = "inactive";
  if (agentType && agentType !== "all") query.agent_type = agentType;
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { name: pattern },
      { code: pattern },
      { contact_person: pattern },
      { email: pattern },
      { phone: pattern }
    ];
  }

  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 50), 100);
  const skip = (page - 1) * limit;
  const [travelAgents, total] = await Promise.all([
    TravelAgent.find(query)
      .sort({ status: 1, name: 1, _id: 1 })
      .skip(skip)
      .limit(limit),
    TravelAgent.countDocuments(query)
  ]);

  return res.status(200).json({
    count: travelAgents.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    travel_agents: travelAgents
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const travelAgent = await inTransaction(async (session) => {
    const record = new TravelAgent({ property_id: propertyId });
    applyAgentPayload(record, req.body || {});
    await record.save({ session });

    await writeAuditLog({
      propertyId,
      entityType: "travel_agent",
      entityId: record._id,
      action: "travel_agent_created",
      description: `Travel agent ${record.name} (${record.code}) was created.`,
      actor: actorFromRequest(req),
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(201).json({
    message: "Travel agent created successfully.",
    travel_agent: travelAgent
  });
}));

router.get("/:travelAgentId/performance", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const travelAgent = await requireTravelAgent(req.params.travelAgentId, propertyId);
  const dateRange = optionalDateRange(req.query.date_from, req.query.date_to);
  const query = {
    property_id: propertyId,
    "travel_agent.travel_agent_id": String(travelAgent._id),
    status: { $in: PERFORMANCE_STATUSES },
    deleted_at: { $exists: false }
  };

  if (dateRange.dateFrom || dateRange.dateTo) {
    query.check_in = {};
    if (dateRange.dateFrom) query.check_in.$gte = dateRange.dateFrom;
    if (dateRange.dateTo) query.check_in.$lte = dateRange.dateTo;
  }

  const reservations = await Reservation.find(query).select({
    reservation_no: 1,
    check_in: 1,
    check_out: 1,
    is_day_room: 1,
    rooms: 1,
    currency: 1,
    financial_summary: 1,
    travel_agent: 1
  });

  const byCurrency = {};
  let roomNights = 0;
  let roomCount = 0;

  for (const reservation of reservations) {
    const currency = String(reservation.currency || "LKR").toUpperCase();
    const grossRevenue = money(reservation.financial_summary?.grand_total);
    const storedCommission = money(reservation.travel_agent?.commission_amount);
    const commissionPercentage = money(reservation.travel_agent?.commission_percentage);
    const commission = storedCommission > 0
      ? storedCommission
      : money(grossRevenue * commissionPercentage / 100);
    const rooms = reservation.rooms.length;
    const nights = reservation.is_day_room
      ? 0
      : Math.max(0, Math.ceil((reservation.check_out - reservation.check_in) / 86_400_000));

    roomCount += rooms;
    roomNights += rooms * nights;
    byCurrency[currency] ||= {
      currency,
      gross_revenue: 0,
      commission: 0,
      net_revenue: 0
    };
    byCurrency[currency].gross_revenue = money(
      byCurrency[currency].gross_revenue + grossRevenue
    );
    byCurrency[currency].commission = money(
      byCurrency[currency].commission + commission
    );
    byCurrency[currency].net_revenue = money(
      byCurrency[currency].gross_revenue - byCurrency[currency].commission
    );
  }

  return res.status(200).json({
    travel_agent: {
      _id: travelAgent._id,
      name: travelAgent.name,
      code: travelAgent.code,
      commission_percentage: travelAgent.commission_percentage,
      status: travelAgent.status
    },
    date_basis: "check_in",
    date_from: req.query.date_from || null,
    date_to: req.query.date_to || null,
    reservation_count: reservations.length,
    room_count: roomCount,
    room_nights: roomNights,
    totals_by_currency: Object.values(byCurrency)
  });
}));

router.get("/:travelAgentId/audit-log", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const travelAgent = await requireTravelAgent(req.params.travelAgentId, propertyId);
  const logs = await BookingAuditLog.find({
    property_id: propertyId,
    entity_type: "travel_agent",
    entity_id: travelAgent._id
  }).sort({ created_at: -1 });

  return res.status(200).json({
    count: logs.length,
    travel_agent_id: travelAgent._id,
    logs
  });
}));

router.get("/:travelAgentId", asyncHandler(async (req, res) => {
  const travelAgent = await requireTravelAgent(
    req.params.travelAgentId,
    requirePropertyId(req)
  );
  return res.status(200).json({ travel_agent: travelAgent });
}));

router.patch("/:travelAgentId/status", asyncHandler(async (req, res) => {
  const status = String(req.body?.status || "").trim().toLowerCase();
  if (!status) throw httpError(400, "status is required.");
  return updateTravelAgent(req, res, { status });
}));

router.patch("/:travelAgentId", asyncHandler(async (req, res) => {
  return updateTravelAgent(req, res, req.body || {});
}));

router.delete("/:travelAgentId", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const result = await inTransaction(async (session) => {
    const travelAgent = await requireTravelAgent(
      req.params.travelAgentId,
      propertyId,
      session
    );

    if (travelAgent.status === "inactive") {
      return { travelAgent, alreadyInactive: true };
    }

    const before = travelAgent.toObject();
    travelAgent.status = "inactive";
    await travelAgent.save({ session });
    await writeAuditLog({
      propertyId,
      entityType: "travel_agent",
      entityId: travelAgent._id,
      action: "travel_agent_deactivated",
      description: `Travel agent ${travelAgent.name} was deactivated. Historical reservations were preserved.`,
      actor: actorFromRequest(req),
      changes: changesFromPayload(before, travelAgent.toObject(), ["status"]),
      requestId: requestId(req),
      session
    });
    return { travelAgent, alreadyInactive: false };
  });

  return res.status(200).json({
    message: result.alreadyInactive
      ? "Travel agent is already inactive."
      : "Travel agent deactivated successfully.",
    travel_agent: result.travelAgent
  });
}));

router.use((error, _req, res, _next) => {
  if (error.status) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error.code === 11000) {
    return res.status(409).json({
      message: "A travel agent with this code already exists for this property."
    });
  }
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError
  ) {
    return res.status(400).json({
      message: "Travel-agent validation failed.",
      errors: Object.values(error.errors || {}).map((item) => item.message)
    });
  }
  if (error instanceof mongoose.Error.VersionError) {
    return res.status(409).json({
      message: "This travel agent was changed by another request. Reload it and try again."
    });
  }

  console.error(error);
  return res.status(500).json({
    message: "The travel-agent request could not be completed."
  });
});

async function updateTravelAgent(req, res, payload) {
  const propertyId = requirePropertyId(req);
  const travelAgent = await inTransaction(async (session) => {
    const record = await requireTravelAgent(
      req.params.travelAgentId,
      propertyId,
      session
    );
    if (
      payload.version !== undefined &&
      Number(payload.version) !== record.__v
    ) {
      throw httpError(409, "This travel agent has changed. Reload it and try again.");
    }

    const before = record.toObject();
    applyAgentPayload(record, payload);
    await record.save({ session });
    const changes = changesFromPayload(before, record.toObject(), AGENT_FIELDS);

    await writeAuditLog({
      propertyId,
      entityType: "travel_agent",
      entityId: record._id,
      action: changes.some((change) => change.field === "status")
        ? `travel_agent_${record.status}`
        : "travel_agent_updated",
      description: `Travel agent ${record.name} was updated.`,
      actor: actorFromRequest(req),
      changes,
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(200).json({
    message: "Travel agent updated successfully.",
    travel_agent: travelAgent
  });
}

function applyAgentPayload(travelAgent, payload) {
  for (const field of AGENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      travelAgent[field] = payload[field];
    }
  }
}

async function requireTravelAgent(id, propertyId, session = null) {
  if (!mongoose.isValidObjectId(id)) {
    throw httpError(400, "travelAgentId must be a valid MongoDB ObjectId.");
  }
  const query = TravelAgent.findOne({ _id: id, property_id: propertyId });
  if (session) query.session(session);
  const travelAgent = await query;
  if (!travelAgent) throw httpError(404, "Travel agent not found.");
  return travelAgent;
}

function requirePropertyId(req) {
  const propertyId = String(
    req.get("x-property-id") ||
    req.query.property_id ||
    req.body?.property_id ||
    ""
  ).trim();
  if (!propertyId) {
    throw httpError(
      400,
      "property_id is required in the body, query string, or x-property-id header."
    );
  }
  return propertyId;
}

function optionalDateRange(from, to) {
  const dateFrom = from ? parseDateOnly(from, "date_from") : null;
  const dateTo = to ? endOfDate(parseDateOnly(to, "date_to")) : null;
  if (dateFrom && dateTo && dateTo < dateFrom) {
    throw httpError(400, "date_to cannot be before date_from.");
  }
  return { dateFrom, dateTo };
}

function parseDateOnly(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw httpError(400, `${field} must use YYYY-MM-DD format.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw httpError(400, `${field} must be a valid calendar date.`);
  }
  return date;
}

function endOfDate(date) {
  return new Date(date.getTime() + 86_400_000 - 1);
}

function normalizeAgentType(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function requestId(req) {
  return String(req.get("x-request-id") || "").trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = router;
