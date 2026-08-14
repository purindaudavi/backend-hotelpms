const express = require("express");
const mongoose = require("mongoose");
const Purchase = require("../db_models/purchase.model");
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
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [{ purchase_no: pattern }, { supplier_name: pattern }, { supplier_invoice_no: pattern }, { narration: pattern }];
  }
  const purchases = await Purchase.find(query).sort({ purchase_date: -1, _id: -1 }).limit(200);
  return res.json({ count: purchases.length, purchases: purchases.map(serializeFinancialDocument) });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const purchase = await inTransaction(async (session) => {
    const purchaseDate = parseDate(req.body?.purchase_date, "purchase_date");
    const purchaseNo = await nextDocumentNumber({ propertyId, documentType: "purchase", date: purchaseDate, session });
    const [record] = await Purchase.create([{
      property_id: propertyId,
      purchase_no: purchaseNo,
      supplier_name: req.body?.supplier_name,
      supplier_invoice_no: req.body?.supplier_invoice_no,
      purchase_date: purchaseDate,
      due_date: req.body?.due_date,
      amount: positiveMoney(req.body?.amount, "amount"),
      currency: req.body?.currency || "LKR",
      narration: req.body?.narration,
      attachments: req.body?.attachments,
      gl_lines: req.body?.gl_lines,
      status: "to_be_paid",
      created_by: actor
    }], { session });
    await postFinancialTransaction({
      propertyId,
      sourceType: "purchase",
      sourceId: record._id,
      sourceNumber: record.purchase_no,
      transactionDate: record.purchase_date,
      direction: "non_cash",
      accountingEffect: "increase",
      amount: record.amount,
      currency: record.currency,
      description: `Purchase ${record.purchase_no} from ${record.supplier_name}; supplier invoice ${record.supplier_invoice_no}.`,
      actor,
      requestId: requestId(req),
      session
    });
    await writeLog(record, "purchase_created", `Purchase ${record.purchase_no} was created and is to be paid.`, actor, req, session);
    return record;
  });
  return res.status(201).json({ message: `Purchase ${purchase.purchase_no} created.`, purchase: serializeFinancialDocument(purchase) });
}));

router.post("/:purchaseId/pay", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const purchase = await inTransaction(async (session) => {
    const record = await findPurchase(req, session);
    if (!record) throw httpError(404, "Purchase not found.");
    if (record.status !== "to_be_paid") throw httpError(409, "Only a purchase that is to be paid can be paid.");
    record.status = "paid";
    record.paid_at = req.body?.paid_at ? parseDate(req.body.paid_at, "paid_at") : new Date();
    record.paid_by = actor;
    record.payment_method = req.body?.payment_method || "other";
    record.payment_reference = req.body?.payment_reference;
    await record.save({ session });
    await postFinancialTransaction({
      propertyId: record.property_id,
      sourceType: "supplier_payment",
      sourceId: record._id,
      sourceNumber: record.purchase_no,
      transactionDate: record.paid_at,
      direction: "out",
      accountingEffect: "decrease",
      amount: record.amount,
      currency: record.currency,
      description: `Supplier payment for purchase ${record.purchase_no} to ${record.supplier_name}.`,
      actor,
      requestId: requestId(req),
      session
    });
    await writeLog(record, "purchase_paid", `Purchase ${record.purchase_no} was paid.`, actor, req, session);
    return record;
  });
  return res.json({ message: `Purchase ${purchase.purchase_no} marked paid.`, purchase: serializeFinancialDocument(purchase) });
}));

router.post("/:purchaseId/void", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw httpError(400, "Void reason is required.");
  const actor = actorFromRequest(req);
  const purchase = await inTransaction(async (session) => {
    const record = await findPurchase(req, session);
    if (!record) throw httpError(404, "Purchase not found.");
    if (record.status === "voided") throw httpError(409, "This purchase is already voided.");
    const wasPaid = record.status === "paid";
    record.status = "voided";
    record.voided_at = new Date();
    record.voided_by = actor;
    record.void_reason = reason;
    await record.save({ session });
    await voidFinancialTransaction({ propertyId: record.property_id, sourceType: "purchase", sourceId: record._id, reason, actor, requestId: requestId(req), voidedAt: record.voided_at, session });
    if (wasPaid) await voidFinancialTransaction({ propertyId: record.property_id, sourceType: "supplier_payment", sourceId: record._id, reason, actor, requestId: requestId(req), voidedAt: record.voided_at, session });
    await writeLog(record, "purchase_voided", `Purchase ${record.purchase_no} was voided: ${reason}`, actor, req, session);
    return record;
  });
  return res.json({ message: `Purchase ${purchase.purchase_no} voided.`, purchase: serializeFinancialDocument(purchase) });
}));

function findPurchase(req, session) { return Purchase.findOne({ _id: objectId(req.params.purchaseId), property_id: requirePropertyId(req) }).session(session || null); }
function writeLog(record, action, description, actor, req, session) { return writeAuditLog({ propertyId: record.property_id, entityType: "purchase", entityId: record._id, action, description, actor, requestId: requestId(req), session }); }
function requirePropertyId(req) { const id = String(req.query.property_id || req.get("x-property-id") || req.body?.property_id || "").trim(); if (!id) throw httpError(400, "property_id is required."); return id; }
function objectId(value) { if (!mongoose.isValidObjectId(value)) throw httpError(400, "purchaseId must be valid."); return new mongoose.Types.ObjectId(value); }
function parseDate(value, field) { const date = new Date(String(value || "")); if (Number.isNaN(date.getTime())) throw httpError(400, `${field} must be a valid date.`); return date; }
function positiveMoney(value, field) { const amount = Math.round((Number(value) + Number.EPSILON) * 100) / 100; if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, `${field} must be greater than zero.`); return amount; }
function normalizeEnum(value) { return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function requestId(req) { return String(req.get("x-request-id") || "").trim(); }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
async function inTransaction(work) { const session = await mongoose.startSession(); try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; } finally { await session.endSession(); } }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
router.use((error, _req, res, _next) => { if (error.code === 11000) return res.status(409).json({ message: "That supplier invoice already exists for this property." }); if (error instanceof mongoose.Error.ValidationError || error.name === "BSONError") return res.status(400).json({ message: "Purchase data validation failed.", errors: Object.values(error.errors || {}).map((item) => item.message) }); if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); console.error(error); return res.status(500).json({ message: "Purchase request failed." }); });

module.exports = router;
