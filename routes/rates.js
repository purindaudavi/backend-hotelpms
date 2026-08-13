const express = require("express");
const mongoose = require("mongoose");
const RoomType = require("../db_models/rooms.model");
const Reservation = require("../db_models/booking.model");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const { MealAllocation } = require("../db_models/property.model");
const {
  quoteRatePlan,
  parseDateOnly,
  dateKey,
  httpError
} = require("../services/rate-quote.service");

const router = express.Router();

const RATE_PLAN_FIELDS = [
  "name",
  "code",
  "currency",
  "meal_plan",
  "meal_allocation_id",
  "valid_from",
  "valid_to",
  "refundable",
  "cancellation_policy",
  "resident",
  "sell_mode",
  "rate_mode",
  "room_type_rates",
  "active",
  "locked",
  "is_custom"
];

const DAILY_RATE_FIELDS = [
  "room_type_id",
  "date",
  "amount",
  "stop_sell",
  "minimum_stay",
  "maximum_stay",
  "closed_to_arrival",
  "closed_to_departure",
  "notes"
];

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };

  if (req.query.active === "true") query.active = true;
  if (req.query.active === "false") query.active = false;
  if (req.query.currency) query.currency = String(req.query.currency).trim().toUpperCase();
  if (req.query.code) query.code = String(req.query.code).trim().toUpperCase();
  if (req.query.search) {
    const expression = new RegExp(escapeRegularExpression(req.query.search), "i");
    query.$or = [{ name: expression }, { code: expression }, { meal_plan: expression }];
  }

  const plans = await RatePlan.find(query)
    .populate("meal_allocation_id")
    .sort({ active: -1, name: 1 });
  return res.status(200).json({
    count: plans.length,
    rate_plans: plans.map(serializeRatePlan)
  });
}));

router.post("/quote", asyncHandler(async (req, res) => {
  const quote = await quoteRatePlan({
    propertyId: requirePropertyId(req),
    ratePlanId: req.body?.rate_plan_id,
    roomTypeId: req.body?.room_type_id,
    checkIn: req.body?.check_in,
    checkOut: req.body?.check_out,
    adults: req.body?.adults,
    children: req.body?.children,
    dayRoom: req.body?.day_room === true
  });
  return res.status(200).json({ quote });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const plan = new RatePlan({ property_id: propertyId });
  applyRatePlanPayload(plan, req.body || {});
  await validateRoomTypeRates(propertyId, plan.room_type_rates);
  await validateMealAllocationLink(propertyId, plan);
  await plan.save();
  await plan.populate("meal_allocation_id");

  return res.status(201).json({
    message: "Rate plan created successfully.",
    rate_plan: serializeRatePlan(plan)
  });
}));

router.get("/:ratePlanId/daily-rates", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const plan = await requireRatePlan(req.params.ratePlanId, propertyId);
  const { dateFrom, dateTo } = requireDateRange(req.query.date_from, req.query.date_to);
  const query = {
    property_id: propertyId,
    rate_plan_id: plan._id,
    date: { $gte: dateFrom, $lte: dateTo }
  };

  if (req.query.room_type_id) {
    if (!mongoose.isValidObjectId(req.query.room_type_id)) {
      throw httpError(400, "room_type_id must be a valid MongoDB ObjectId.");
    }
    query.room_type_id = req.query.room_type_id;
  }

  const dailyRates = await DailyRate.find(query).sort({ date: 1, room_type_id: 1 });
  return res.status(200).json({
    count: dailyRates.length,
    rate_plan_id: plan._id,
    daily_rates: dailyRates.map(serializeDailyRate)
  });
}));

router.put("/:ratePlanId/daily-rates", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const plan = await requireRatePlan(req.params.ratePlanId, propertyId);
  if (plan.locked) {
    throw httpError(409, "Unlock this rate plan before changing daily rates.");
  }

  const payloads = req.body?.daily_rates;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw httpError(400, "daily_rates must be a non-empty array.");
  }
  if (payloads.length > 500) {
    throw httpError(400, "A daily-rate update can contain at most 500 rows.");
  }

  const documents = payloads.map((payload) => {
    const dailyRate = new DailyRate({
      property_id: propertyId,
      rate_plan_id: plan._id
    });
    applyDailyRatePayload(dailyRate, payload || {});
    return dailyRate;
  });
  await Promise.all(documents.map((document) => document.validate()));
  await validateDailyRateBatch(propertyId, plan, documents);

  const now = new Date();
  await DailyRate.bulkWrite(documents.map((document) => ({
    updateOne: {
      filter: {
        property_id: propertyId,
        rate_plan_id: plan._id,
        room_type_id: document.room_type_id,
        date: document.date
      },
      update: {
        $set: {
          amount: document.amount,
          stop_sell: document.stop_sell,
          minimum_stay: document.minimum_stay,
          maximum_stay: document.maximum_stay,
          closed_to_arrival: document.closed_to_arrival,
          closed_to_departure: document.closed_to_departure,
          notes: document.notes,
          updated_at: now
        },
        $setOnInsert: {
          property_id: propertyId,
          rate_plan_id: plan._id,
          room_type_id: document.room_type_id,
          date: document.date,
          created_at: now
        }
      },
      upsert: true
    }
  })));

  const savedRates = await DailyRate.find({
    property_id: propertyId,
    rate_plan_id: plan._id,
    $or: documents.map((document) => ({
      room_type_id: document.room_type_id,
      date: document.date
    }))
  }).sort({ date: 1, room_type_id: 1 });

  return res.status(200).json({
    message: `${savedRates.length} daily rate(s) saved successfully.`,
    count: savedRates.length,
    daily_rates: savedRates.map(serializeDailyRate)
  });
}));

router.delete("/:ratePlanId/daily-rates/:dailyRateId", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const plan = await requireRatePlan(req.params.ratePlanId, propertyId);
  if (plan.locked) {
    throw httpError(409, "Unlock this rate plan before deleting daily rates.");
  }
  if (!mongoose.isValidObjectId(req.params.dailyRateId)) {
    throw httpError(400, "dailyRateId must be a valid MongoDB ObjectId.");
  }

  const deleted = await DailyRate.findOneAndDelete({
    _id: req.params.dailyRateId,
    property_id: propertyId,
    rate_plan_id: plan._id
  });
  if (!deleted) throw httpError(404, "Daily rate not found.");
  return res.status(200).json({ message: "Daily rate override deleted successfully." });
}));

router.get("/:ratePlanId", asyncHandler(async (req, res) => {
  const plan = await requireRatePlan(req.params.ratePlanId, requirePropertyId(req));
  await plan.populate("meal_allocation_id");
  return res.status(200).json({ rate_plan: serializeRatePlan(plan) });
}));

router.patch("/:ratePlanId", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const plan = await requireRatePlan(req.params.ratePlanId, propertyId);
  const payload = req.body || {};
  const changesLockedValues = RATE_PLAN_FIELDS.some((field) =>
    !["active", "locked"].includes(field) &&
    Object.prototype.hasOwnProperty.call(payload, field)
  );
  if (plan.locked && changesLockedValues) {
    throw httpError(409, "Unlock this rate plan before changing its configuration or prices.");
  }

  applyRatePlanPayload(plan, payload);
  await validateRoomTypeRates(propertyId, plan.room_type_rates);
  await validateMealAllocationLink(propertyId, plan);
  await plan.save();
  await plan.populate("meal_allocation_id");
  return res.status(200).json({
    message: "Rate plan updated successfully.",
    rate_plan: serializeRatePlan(plan)
  });
}));

router.delete("/:ratePlanId", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const plan = await requireRatePlan(req.params.ratePlanId, propertyId);
  const ratePlanId = String(plan._id);
  const bookingReferences = await Reservation.countDocuments({
    property_id: propertyId,
    $or: [
      { rate_plan_id: ratePlanId },
      { "rooms.rate_plan_id": ratePlanId }
    ]
  });
  if (bookingReferences > 0) {
    throw httpError(
      409,
      "This rate plan is referenced by reservations. Disable it instead of deleting it."
    );
  }

  await DailyRate.deleteMany({ property_id: propertyId, rate_plan_id: plan._id });
  await plan.deleteOne();
  return res.status(200).json({ message: "Rate plan deleted successfully." });
}));

router.use((error, _req, res, _next) => {
  if (error.code === 11000) {
    const duplicatedField = error.keyPattern?.code
      ? "rate plan code"
      : error.keyPattern?.slug
        ? "rate plan name"
        : "daily rate";
    return res.status(409).json({
      message: `That ${duplicatedField} already exists for this property.`
    });
  }
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError ||
    error.name === "BSONError"
  ) {
    return res.status(400).json({
      message: "Rate data validation failed.",
      errors: Object.values(error.errors || {}).map((item) => item.message)
    });
  }
  if (error instanceof mongoose.Error.VersionError) {
    return res.status(409).json({
      message: "This rate was changed by another request. Reload it and try again."
    });
  }
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      message: error.message,
      ...(error.code ? { code: error.code } : {})
    });
  }

  console.error(error);
  return res.status(500).json({ message: "The rate request could not be completed." });
});

function requirePropertyId(req) {
  const propertyId = String(
    req.query.property_id || req.get("x-property-id") || req.body?.property_id || ""
  ).trim();
  if (!propertyId) throw httpError(400, "property_id is required.");
  return propertyId;
}

async function requireRatePlan(ratePlanId, propertyId) {
  if (!mongoose.isValidObjectId(ratePlanId)) {
    throw httpError(400, "ratePlanId must be a valid MongoDB ObjectId.");
  }
  const plan = await RatePlan.findOne({ _id: ratePlanId, property_id: propertyId });
  if (!plan) throw httpError(404, "Rate plan not found.");
  return plan;
}

function applyRatePlanPayload(plan, payload) {
  RATE_PLAN_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) return;
    if (field === "room_type_rates") {
      if (!Array.isArray(payload.room_type_rates)) {
        throw httpError(400, "room_type_rates must be an array.");
      }
      plan.room_type_rates = payload.room_type_rates.map((rate) => ({
        room_type_id: rate?.room_type_id,
        amount: rate?.amount
      }));
      return;
    }
    if (field === "sell_mode" || field === "rate_mode") {
      plan[field] = normalizeEnum(payload[field]);
      return;
    }
    plan[field] = payload[field];
  });
}

function applyDailyRatePayload(dailyRate, payload) {
  DAILY_RATE_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) return;
    dailyRate[field] = field === "date"
      ? parseDateOnly(payload[field], "date")
      : payload[field];
  });
}

async function validateRoomTypeRates(propertyId, roomTypeRates) {
  if (!Array.isArray(roomTypeRates) || roomTypeRates.length === 0) return;
  const ids = roomTypeRates.map((rate) => rate.room_type_id);
  if (ids.some((id) => !mongoose.isValidObjectId(id))) {
    throw httpError(400, "Every room_type_id must be a valid MongoDB ObjectId.");
  }
  const uniqueIds = [...new Set(ids.map(String))];
  const count = await RoomType.countDocuments({
    property_id: propertyId,
    _id: { $in: uniqueIds }
  });
  if (count !== uniqueIds.length) {
    throw httpError(400, "Every room type must belong to the selected property.");
  }
}

async function validateMealAllocationLink(propertyId, plan) {
  if (plan.meal_plan === "Room Only") {
    plan.meal_allocation_id = null;
    return;
  }
  if (!plan.meal_allocation_id) {
    throw httpError(
      400,
      `${plan.meal_plan} requires a meal allocation from Settings > Property > Meal Allocation.`
    );
  }
  if (!mongoose.isValidObjectId(plan.meal_allocation_id)) {
    throw httpError(400, "meal_allocation_id must be a valid MongoDB ObjectId.");
  }
  const allocation = await MealAllocation.findOne({
    _id: plan.meal_allocation_id,
    property_id: propertyId
  });
  if (!allocation) throw httpError(404, "Meal allocation not found for this property.");
  if (!allocation.active) throw httpError(409, "The selected meal allocation is retired.");
  if (allocation.meal_plan !== plan.meal_plan) {
    throw httpError(409, "The meal allocation must match the rate plan meal plan.");
  }
  if (allocation.currency !== plan.currency) {
    throw httpError(409, "The meal allocation and rate plan must use the same currency.");
  }
}

async function validateDailyRateBatch(propertyId, plan, documents) {
  const combinations = documents.map((document) =>
    `${String(document.room_type_id)}::${dateKey(document.date)}`
  );
  if (new Set(combinations).size !== combinations.length) {
    throw httpError(400, "The same room type and date can appear only once per request.");
  }

  const roomTypeIds = [...new Set(documents.map((document) => String(document.room_type_id)))];
  if (roomTypeIds.some((id) => !mongoose.isValidObjectId(id))) {
    throw httpError(400, "Every room_type_id must be a valid MongoDB ObjectId.");
  }
  const roomTypeCount = await RoomType.countDocuments({
    property_id: propertyId,
    _id: { $in: roomTypeIds }
  });
  if (roomTypeCount !== roomTypeIds.length) {
    throw httpError(400, "Every room type must belong to the selected property.");
  }

  const configuredRoomTypes = new Set(plan.room_type_rates.map((rate) => String(rate.room_type_id)));
  const missingRate = roomTypeIds.find((roomTypeId) => !configuredRoomTypes.has(roomTypeId));
  if (missingRate) {
    throw httpError(409, "Daily rates can only be added for room types configured in the rate plan.");
  }

  const validFrom = new Date(plan.valid_from);
  const validTo = new Date(plan.valid_to);
  const outsideValidity = documents.find(
    (document) => document.date < validFrom || document.date > validTo
  );
  if (outsideValidity) {
    throw httpError(
      409,
      `Daily rate ${dateKey(outsideValidity.date)} is outside the rate plan validity period.`
    );
  }
}

function requireDateRange(fromValue, toValue) {
  const dateFrom = parseDateOnly(fromValue, "date_from");
  const dateTo = parseDateOnly(toValue, "date_to");
  if (dateTo < dateFrom) throw httpError(400, "date_to cannot be before date_from.");
  const days = Math.floor((dateTo - dateFrom) / 86_400_000) + 1;
  if (days > 366) throw httpError(400, "The daily-rate date range cannot exceed 366 days.");
  return { dateFrom, dateTo };
}

function serializeRatePlan(plan) {
  const allocation = plan.meal_allocation_id;
  const result = plan.toObject({ virtuals: true });
  if (allocation?._id) {
    result.meal_allocation_id = allocation._id;
    result.meal_allocation = serializeMealAllocation(allocation);
  } else {
    result.meal_allocation_id = allocation || null;
    result.meal_allocation = null;
  }
  result.valid_from = dateKey(plan.valid_from);
  result.valid_to = dateKey(plan.valid_to);
  result.version = plan.__v;
  delete result.__v;
  return result;
}

function serializeMealAllocation(allocation) {
  return {
    _id: allocation._id,
    name: allocation.name,
    meal_plan: allocation.meal_plan,
    currency: allocation.currency,
    adult_amounts: allocation.adult_amounts,
    child_amounts: allocation.child_amounts,
    valid_from: dateKey(allocation.valid_from),
    valid_to: dateKey(allocation.valid_to),
    active: allocation.active,
    notes: allocation.notes,
    version: allocation.version
  };
}

function serializeDailyRate(dailyRate) {
  const result = dailyRate.toObject();
  result.date = dateKey(dailyRate.date);
  result.version = dailyRate.__v;
  delete result.__v;
  return result;
}

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function escapeRegularExpression(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = router;
