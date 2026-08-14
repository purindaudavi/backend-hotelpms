const express = require("express");
const mongoose = require("mongoose");
const FinancialTransaction = require("../db_models/financial-transaction.model");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };
  const status = normalizeEnum(req.query.status);
  const direction = normalizeEnum(req.query.direction);
  const sourceType = normalizeEnum(req.query.source_type);
  if (status && status !== "all") query.status = status;
  if (direction && direction !== "all") query.direction = direction;
  if (sourceType && sourceType !== "all") query.source_type = sourceType;
  if (req.query.reservation_id) query.reservation_id = objectId(req.query.reservation_id, "reservation_id");
  if (req.query.date_from || req.query.date_to) query.transaction_date = {};
  if (req.query.date_from) query.transaction_date.$gte = parseDate(req.query.date_from, "date_from");
  if (req.query.date_to) query.transaction_date.$lte = endOfDay(req.query.date_to, "date_to");

  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { transaction_no: pattern },
      { source_number: pattern },
      { reservation_no: pattern },
      { description: pattern },
      { room_numbers: pattern }
    ];
  }

  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const [transactions, total] = await Promise.all([
    FinancialTransaction.find(query)
      .sort({ transaction_date: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    FinancialTransaction.countDocuments(query)
  ]);

  return res.status(200).json({
    count: transactions.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    transactions: transactions.map(serialize)
  });
}));

router.get("/:transactionId", asyncHandler(async (req, res) => {
  const transaction = await FinancialTransaction.findOne({
    _id: objectId(req.params.transactionId, "transactionId"),
    property_id: requirePropertyId(req)
  });
  if (!transaction) throw httpError(404, "Financial transaction not found.");
  return res.status(200).json({ transaction: serialize(transaction) });
}));

router.use((error, _req, res, _next) => {
  if (error instanceof mongoose.Error.CastError || error.name === "BSONError") {
    return res.status(400).json({ message: "Financial transaction data validation failed." });
  }
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: "Financial transactions could not be loaded." });
});

function requirePropertyId(req) {
  const value = String(req.query.property_id || req.get("x-property-id") || "").trim();
  if (!value) throw httpError(400, "property_id is required in the query or x-property-id header.");
  return value;
}

function objectId(value, field) {
  if (!mongoose.isValidObjectId(value)) throw httpError(400, `${field} must be a valid MongoDB ObjectId.`);
  return new mongoose.Types.ObjectId(value);
}

function parseDate(value, field) {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw httpError(400, `${field} must be a valid date.`);
  return date;
}

function endOfDay(value, field) {
  const date = parseDate(value, field);
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serialize(document) {
  const value = document.toObject({ virtuals: true });
  value.version = value.__v;
  delete value.__v;
  return value;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = router;
