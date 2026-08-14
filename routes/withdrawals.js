const express = require("express");
const mongoose = require("mongoose");
const Withdrawal = require("../db_models/withdrawal.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const { actorFromRequest, writeAuditLog } = require("../services/booking-audit.service");
const { nextDocumentNumber, serializeFinancialDocument } = require("../services/financial-document.service");
const {
  postFinancialTransaction,
  voidFinancialTransaction
} = require("../services/financial-transaction.service");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };
  const status = normalizeEnum(req.query.status);
  if (status && status !== "all") query.status = status;
  const currency = String(req.query.currency || "").trim().toUpperCase();
  if (currency && currency !== "ALL") query.currency = currency;
  const sourceAccount = normalizeEnum(req.query.source_account);
  if (sourceAccount && sourceAccount !== "all") query.source_account = sourceAccount;
  if (req.query.date_from || req.query.date_to) query.money_received_at = {};
  if (req.query.date_from) query.money_received_at.$gte = parseDate(req.query.date_from, "date_from");
  if (req.query.date_to) query.money_received_at.$lte = endOfDay(req.query.date_to, "date_to");

  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { withdrawal_no: pattern },
      { paid_to: pattern },
      { reference_number: pattern },
      { reason: pattern }
    ];
  }

  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const [withdrawals, total, totals] = await Promise.all([
    Withdrawal.find(query).sort({ money_received_at: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit),
    Withdrawal.countDocuments(query),
    Withdrawal.aggregate([
      { $match: { property_id: propertyId, status: "completed" } },
      { $group: { _id: "$currency", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ])
  ]);

  return res.status(200).json({
    count: withdrawals.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    totals: totals.map((item) => ({ currency: item._id, amount: money(item.amount), count: item.count })),
    withdrawals: withdrawals.map(serializeWithdrawal)
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const moneyReceivedAt = parseDate(req.body?.money_received_at, "money_received_at");
  if (moneyReceivedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw badRequest("money_received_at cannot be in the future.");
  }

  const withdrawal = await inTransaction(async (session) => {
    const withdrawalNo = await nextDocumentNumber({
      propertyId,
      documentType: "withdrawal",
      date: moneyReceivedAt,
      session
    });
    const [record] = await Withdrawal.create([{
      property_id: propertyId,
      withdrawal_no: withdrawalNo,
      paid_to: "ASIRI PERERA",
      amount: positiveMoney(req.body?.amount, "amount"),
      currency: req.body?.currency || "LKR",
      source_account: req.body?.source_account,
      payment_method: req.body?.payment_method,
      reason: req.body?.reason,
      money_received_at: moneyReceivedAt,
      reference_number: req.body?.reference_number,
      notes: req.body?.notes,
      status: "completed",
      recorded_by: actor
    }], { session });

    await postFinancialTransaction({
      propertyId: record.property_id,
      sourceType: "withdrawal",
      sourceId: record._id,
      sourceNumber: record.withdrawal_no,
      transactionDate: record.money_received_at,
      direction: "out",
      accountingEffect: "decrease",
      amount: record.amount,
      currency: record.currency,
      description: `Withdrawal ${record.withdrawal_no} paid to ${record.paid_to}: ${record.reason}`,
      actor,
      requestId: requestId(req),
      session
    });

    await writeWithdrawalLog({
      withdrawal: record,
      action: "withdrawal_recorded",
      description: `Withdrawal ${record.withdrawal_no} was recorded for ${record.currency} ${record.amount.toFixed(2)} paid to ${record.paid_to}.`,
      actor, req, session
    });
    return record;
  });

  return res.status(201).json({
    message: `Withdrawal ${withdrawal.withdrawal_no} recorded successfully.`,
    withdrawal: serializeWithdrawal(withdrawal)
  });
}));

router.get("/:withdrawalId", asyncHandler(async (req, res) => {
  const withdrawal = await findWithdrawal(req);
  if (!withdrawal) throw notFound("Withdrawal not found.");
  const logs = await BookingAuditLog.find({
    property_id: withdrawal.property_id,
    entity_type: "withdrawal",
    entity_id: withdrawal._id
  }).sort({ created_at: -1 });
  return res.status(200).json({ withdrawal: serializeWithdrawal(withdrawal), logs });
}));

router.post("/:withdrawalId/void", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw badRequest("Void reason is required.");
  const actor = actorFromRequest(req);
  const withdrawal = await inTransaction(async (session) => {
    const record = await findWithdrawal(req, session);
    if (!record) throw notFound("Withdrawal not found.");
    if (record.status === "voided") throw conflict("This withdrawal is already voided.");
    record.status = "voided";
    record.void_reason = reason;
    record.voided_at = new Date();
    record.voided_by = actor;
    await record.save({ session });
    await voidFinancialTransaction({
      propertyId: record.property_id,
      sourceType: "withdrawal",
      sourceId: record._id,
      reason,
      actor,
      requestId: requestId(req),
      voidedAt: record.voided_at,
      session
    });
    await writeWithdrawalLog({
      withdrawal: record,
      action: "withdrawal_voided",
      description: `Withdrawal ${record.withdrawal_no} was voided: ${reason}`,
      actor, req, session
    });
    return record;
  });

  return res.status(200).json({
    message: `Withdrawal ${withdrawal.withdrawal_no} voided successfully. Its amount no longer counts as money withdrawn.`,
    withdrawal: serializeWithdrawal(withdrawal)
  });
}));

router.use(withdrawalErrorHandler);

async function findWithdrawal(req, session) {
  return Withdrawal.findOne({
    _id: objectId(req.params.withdrawalId, "withdrawalId"),
    property_id: requirePropertyId(req)
  }).session(session || null);
}

function writeWithdrawalLog({ withdrawal, action, description, actor, req, session }) {
  return writeAuditLog({
    propertyId: withdrawal.property_id,
    entityType: "withdrawal",
    entityId: withdrawal._id,
    action,
    description,
    actor,
    requestId: String(req.get("x-request-id") || "").trim(),
    session
  });
}

function requestId(req) {
  return String(req.get("x-request-id") || "").trim();
}

function serializeWithdrawal(withdrawal) {
  const value = serializeFinancialDocument(withdrawal);
  value.effective_amount = value.status === "completed" ? value.amount : 0;
  return value;
}

function requirePropertyId(req) {
  const value = String(req.query.property_id || req.get("x-property-id") || req.body?.property_id || "").trim();
  if (!value) throw badRequest("property_id is required in the query, body, or x-property-id header.");
  return value;
}

function objectId(value, field) {
  if (!mongoose.isValidObjectId(value)) throw badRequest(`${field} must be a valid MongoDB ObjectId.`);
  return new mongoose.Types.ObjectId(value);
}

function positiveMoney(value, field) {
  const amount = money(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest(`${field} must be greater than zero.`);
  return amount;
}

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function parseDate(value, field) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) throw badRequest(`${field} must be a valid date.`);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function withdrawalErrorHandler(error, _req, res, _next) {
  if (error.code === 11000) return res.status(409).json({ message: "That withdrawal number or reference already exists." });
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError || error.name === "BSONError") {
    return res.status(400).json({
      message: "Withdrawal data validation failed.",
      errors: Object.values(error.errors || {}).map((item) => item.message)
    });
  }
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: "The withdrawal request could not be completed." });
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function badRequest(message) { return httpError(400, message); }
function notFound(message) { return httpError(404, message); }
function conflict(message) { return httpError(409, message); }

module.exports = router;
