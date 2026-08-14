const express = require("express");
const mongoose = require("mongoose");
const Expense = require("../db_models/expense.model");
const { actorFromRequest, writeAuditLog } = require("../services/booking-audit.service");
const { nextDocumentNumber, serializeFinancialDocument } = require("../services/financial-document.service");
const { postFinancialTransaction, voidFinancialTransaction } = require("../services/financial-transaction.service");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };
  const status = normalizeEnum(req.query.status);
  if (status && status !== "all") query.status = status;
  const search = String(req.query.search || "").trim();
  if (search) { const pattern = new RegExp(escapeRegExp(search), "i"); query.$or = [{ expense_no: pattern }, { expense_type: pattern }, { description: pattern }, { remark: pattern }]; }
  const expenses = await Expense.find(query).sort({ expense_date: -1, _id: -1 }).limit(200);
  return res.json({ count: expenses.length, expenses: expenses.map(serializeFinancialDocument) });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const expense = await inTransaction(async (session) => {
    const expenseDate = parseDate(req.body?.expense_date, "expense_date");
    const expenseNo = await nextDocumentNumber({ propertyId, documentType: "expense", date: expenseDate, session });
    const [record] = await Expense.create([{
      property_id: propertyId,
      expense_no: expenseNo,
      expense_date: expenseDate,
      expense_type: req.body?.expense_type,
      paid_using: req.body?.paid_using,
      description: req.body?.description,
      amount: positiveMoney(req.body?.amount, "amount"),
      currency: req.body?.currency || "LKR",
      attachments: req.body?.attachments,
      remark: req.body?.remark,
      status: "posted",
      created_by: actor
    }], { session });
    await postFinancialTransaction({ propertyId, sourceType: "expense", sourceId: record._id, sourceNumber: record.expense_no, transactionDate: record.expense_date, direction: "out", accountingEffect: "decrease", amount: record.amount, currency: record.currency, description: `${record.expense_type}: ${record.description || record.remark || record.expense_no}`, actor, requestId: requestId(req), session });
    await writeAuditLog({ propertyId, entityType: "expense", entityId: record._id, action: "expense_posted", description: `Expense ${record.expense_no} was posted for ${record.currency} ${record.amount.toFixed(2)}.`, actor, requestId: requestId(req), session });
    return record;
  });
  return res.status(201).json({ message: `Expense ${expense.expense_no} posted.`, expense: serializeFinancialDocument(expense) });
}));

router.post("/:expenseId/void", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw httpError(400, "Void reason is required.");
  const actor = actorFromRequest(req);
  const expense = await inTransaction(async (session) => {
    const record = await Expense.findOne({ _id: objectId(req.params.expenseId), property_id: requirePropertyId(req) }).session(session);
    if (!record) throw httpError(404, "Expense not found.");
    if (record.status === "voided") throw httpError(409, "This expense is already voided.");
    record.status = "voided"; record.voided_at = new Date(); record.voided_by = actor; record.void_reason = reason;
    await record.save({ session });
    await voidFinancialTransaction({ propertyId: record.property_id, sourceType: "expense", sourceId: record._id, reason, actor, requestId: requestId(req), voidedAt: record.voided_at, session });
    await writeAuditLog({ propertyId: record.property_id, entityType: "expense", entityId: record._id, action: "expense_voided", description: `Expense ${record.expense_no} was voided: ${reason}`, actor, requestId: requestId(req), session });
    return record;
  });
  return res.json({ message: `Expense ${expense.expense_no} voided.`, expense: serializeFinancialDocument(expense) });
}));

function requirePropertyId(req) { const id = String(req.query.property_id || req.get("x-property-id") || req.body?.property_id || "").trim(); if (!id) throw httpError(400, "property_id is required."); return id; }
function objectId(value) { if (!mongoose.isValidObjectId(value)) throw httpError(400, "expenseId must be valid."); return new mongoose.Types.ObjectId(value); }
function parseDate(value, field) { const date = new Date(String(value || "")); if (Number.isNaN(date.getTime())) throw httpError(400, `${field} must be a valid date.`); return date; }
function positiveMoney(value, field) { const amount = Math.round((Number(value) + Number.EPSILON) * 100) / 100; if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, `${field} must be greater than zero.`); return amount; }
function normalizeEnum(value) { return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function requestId(req) { return String(req.get("x-request-id") || "").trim(); }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
async function inTransaction(work) { const session = await mongoose.startSession(); try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; } finally { await session.endSession(); } }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
router.use((error, _req, res, _next) => { if (error.code === 11000) return res.status(409).json({ message: "That expense number already exists." }); if (error instanceof mongoose.Error.ValidationError || error.name === "BSONError") return res.status(400).json({ message: "Expense data validation failed.", errors: Object.values(error.errors || {}).map((item) => item.message) }); if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); console.error(error); return res.status(500).json({ message: "Expense request failed." }); });

module.exports = router;
