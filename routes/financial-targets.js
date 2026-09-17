const express = require("express");
const mongoose = require("mongoose");
const FinancialTarget = require("../db_models/financial-target.model");
const { actorFromRequest, writeAuditLog } = require("../services/booking-audit.service");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const query = { property_id: requirePropertyId(req), metric: "net_profit" };
  if (req.query.currency) query.currency = currency(req.query.currency);
  const targets = await FinancialTarget.find(query).sort({ month: 1, _id: 1 });
  return res.json({ count: targets.length, targets: targets.map(serialize) });
}));

router.put("/:month", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const month = validMonth(req.params.month);
  const selectedCurrency = currency(req.body?.currency || "LKR");
  const amount = nonNegativeMoney(req.body?.amount);
  const actor = actorFromRequest(req);
  const existing = await FinancialTarget.findOne({ property_id: propertyId, month, metric: "net_profit", currency: selectedCurrency });
  const target = existing || new FinancialTarget({
    property_id: propertyId,
    month,
    metric: "net_profit",
    currency: selectedCurrency,
    created_by: actor
  });
  const previousAmount = existing?.amount;
  target.amount = amount;
  target.updated_by = actor;
  await target.save();
  await writeAuditLog({
    propertyId,
    entityType: "financial_target",
    entityId: target._id,
    action: existing ? "financial_target_updated" : "financial_target_created",
    description: `Net-profit target for ${month} was set to ${selectedCurrency} ${amount.toFixed(2)}.`,
    actor,
    changes: [{ field: "amount", from: previousAmount, to: amount }],
    requestId: String(req.get("x-request-id") || "").trim()
  });
  return res.status(existing ? 200 : 201).json({ message: `Target for ${month} saved.`, target: serialize(target) });
}));

router.delete("/:month", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const month = validMonth(req.params.month);
  const selectedCurrency = currency(req.query.currency || "LKR");
  const target = await FinancialTarget.findOneAndDelete({ property_id: propertyId, month, metric: "net_profit", currency: selectedCurrency });
  if (!target) throw httpError(404, "No saved target was found for that month.");
  const actor = actorFromRequest(req);
  await writeAuditLog({
    propertyId,
    entityType: "financial_target",
    entityId: target._id,
    action: "financial_target_removed",
    description: `Net-profit target for ${month} was removed.`,
    actor,
    requestId: String(req.get("x-request-id") || "").trim()
  });
  return res.json({ message: `Target for ${month} removed.` });
}));

function requirePropertyId(req) {
  const value = String(req.query.property_id || req.get("x-property-id") || req.body?.property_id || "").trim();
  if (!value) throw httpError(400, "property_id is required.");
  return value;
}
function validMonth(value) {
  const month = String(value || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw httpError(400, "month must use YYYY-MM format.");
  return month;
}
function currency(value) {
  const result = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw httpError(400, "currency must be a three-letter code such as LKR.");
  return result;
}
function nonNegativeMoney(value) {
  const amount = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0) throw httpError(400, "amount must be zero or greater.");
  return amount;
}
function serialize(document) {
  const value = document.toObject({ virtuals: true });
  value.version = value.__v;
  delete value.__v;
  return value;
}
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }

router.use((error, _req, res, _next) => {
  if (error.code === 11000) return res.status(409).json({ message: "A target already exists for that property, month, metric, and currency." });
  if (error instanceof mongoose.Error.ValidationError || error.name === "BSONError") {
    return res.status(400).json({ message: "Financial target validation failed.", errors: Object.values(error.errors || {}).map((item) => item.message) });
  }
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: "Financial target request failed." });
});

module.exports = router;
