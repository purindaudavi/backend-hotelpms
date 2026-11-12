const express = require("express"), mongoose = require("mongoose");
const Request = require("../db_models/money-request.model");
const FundsOpening = require("../db_models/funds-opening.model");
const { actorFromRequest, writeAuditLog } = require("../services/booking-audit.service");
const { withInventoryTransaction } = require("../services/inventory-transaction.service");
const { nextDocumentNumber } = require("../services/financial-document.service");
const { postFinancialTransaction } = require("../services/financial-transaction.service");
const { recordedFunds } = require("../services/recorded-funds.service");
const { context, visibleFilter, requireOwner, checkVersion, positiveAmount, paidDate, event, recordRequestCost, serialize, receiptInput, fail } = require("../services/money-request.service");
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.get("/funds", wrap(async (req, res) => {
  const ctx = await context(req);
  if (!["owner", "administrator"].includes(ctx.role)) throw fail(403, "Only Owner/Admin can view recorded funds.");
  res.json({ balances: await recordedFunds(ctx.propertyId), basis: "Opening funds plus recorded payments received minus completed payments out. Excludes unpaid invoices and Night Audit revenue. Not a live bank balance." });
}));
router.post("/funds/opening", wrap(async (req, res) => {
  const before = await context(req); requireOwner(before);
  const actor = actorFromRequest(req), currency = String(req.body.currency || "").trim().toUpperCase();
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!/^[A-Z]{3}$/.test(currency) || req.body.amount === undefined || req.body.amount === null || req.body.amount === "" || !Number.isFinite(amount) || amount < 0) throw fail(400, "Enter a currency and a non-negative opening amount.");
  if (req.body.confirmed_before_recorded_movements !== true) throw fail(400, "Confirm this is money available before the payments already recorded in this PMS, not today's bank balance.");
  const opening = await withInventoryTransaction(before.propertyId, async session => {
    const ctx = await context(req, session); requireOwner(ctx);
    if (await FundsOpening.findOne({ property_id: ctx.propertyId, currency }).session(session)) throw fail(409, `An opening balance for ${currency} is already set. It cannot be added twice.`);
    const [record] = await FundsOpening.create([{ property_id: ctx.propertyId, currency, amount, note: req.body.note, created_by: actor }], { session });
    await writeAuditLog({ propertyId: ctx.propertyId, entityType: "funds_opening", entityId: record._id, action: "opening_balance_set", description: `Opening balance ${currency} ${amount.toFixed(2)} set once. ${record.note}`, actor, session });
    return record;
  });
  res.status(201).json({ opening, balances: await recordedFunds(before.propertyId) });
}));
router.get("/", wrap(async (req, res) => {
  const ctx = await context(req), filter = visibleFilter(ctx);
  if (req.query.status && req.query.status !== "all") filter.status = String(req.query.status);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1), limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const [records, total] = await Promise.all([Request.find(filter).sort({ created_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit), Request.countDocuments(filter)]);
  res.json({ requests: records.map(serialize), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));
router.post("/", wrap(async (req, res) => {
  const before = await context(req), actor = actorFromRequest(req);
  const record = await withInventoryTransaction(before.propertyId, async session => {
    const ctx = await context(req, session);
    const no = await nextDocumentNumber({ propertyId: ctx.propertyId, documentType: "money_request", session });
    const [record] = await Request.create([{
      property_id: ctx.propertyId, request_no: no, requester_id: ctx.userId, requester: actor,
      requester_role: ctx.role, amount: positiveAmount(req.body.amount), currency: req.body.currency,
      purpose: req.body.purpose, kind: req.body.kind || "advance", status: "pending",
      history: [{ action: "requested", actor, at: new Date() }]
    }], { session });
    await audit(record, "requested", actor, "Money requested; no funds deducted.", session, ctx.property.owner_id);
    return record;
  });
  res.status(201).json({ request: serialize(record) });
}));
router.get("/:id", wrap(async (req, res) => res.json({ request: serialize(await read(req)) })));
// Express 5 does not accept regexp alternatives in a route parameter.
for (const action of ["approve", "reject", "cancel", "pay", "settle"]) router.post(`/:id/${action}`, wrap(async (req, res) => {
  const before = await context(req), actor = actorFromRequest(req);
  const record = await withInventoryTransaction(before.propertyId, async session => {
    const ctx = await context(req, session), record = await read(req, ctx, session);
    checkVersion(record, req.body.version);
    if (action !== "cancel") requireOwner(ctx);
    const note = String(req.body.note || "").trim();
    if (note.length > 1000) throw fail(400, "Notes cannot exceed 1000 characters.");
    if (action === "approve") {
      if (record.status !== "pending") throw fail(409, "Only a pending request can be approved.");
      record.status = "approved"; record.approved_by = actor; record.approved_at = new Date();
    } else if (action === "reject" || action === "cancel") {
      if (action === "cancel" && String(record.requester_id) !== ctx.userId) throw fail(403, "Only the requester can cancel their own request.");
      if (!["pending", "approved"].includes(record.status) || (action === "cancel" && record.status !== "pending")) throw fail(409, "This request cannot be rejected or cancelled now.");
      if (note.length < 5) throw fail(400, "Enter a reason of at least 5 characters.");
      record.status = action === "reject" ? "rejected" : "cancelled";
    } else if (action === "pay") {
      if (record.status !== "approved") throw fail(409, "Approve this request before recording payment.");
      if (req.body.payment_confirmed !== true) throw fail(400, "Confirm the money was actually paid before marking Paid.");
      record.paid_at = paidDate(req.body.paid_at); record.paid_by = actor;
      record.payment_method = req.body.payment_method; record.payment_reference = req.body.payment_reference;
      record.payment_method_details = String(req.body.payment_method_details || "").trim();
      if (record.payment_method === "other" && !record.payment_method_details) throw fail(400, "Please specify the payment method.");
      record.payment_note = note; record.status = "paid";
      if (record.kind === "expense") { await recordRequestCost(record, record.amount, actor, session); record.actual_spent = record.amount; record.returned_amount = 0; record.settled_at = new Date(); record.settled_by = actor; }
      await record.validate();
      await postFinancialTransaction({ propertyId: ctx.propertyId, sourceType: "money_request", sourceId: record._id, sourceNumber: record.request_no,
        transactionDate: record.paid_at, direction: "out", accountingEffect: "decrease", amount: record.amount, currency: record.currency,
        description: `Staff payment to ${record.requester.name}: ${record.purpose}`, actor, session });
    } else if (action === "settle") {
      if (record.status !== "paid" || record.kind !== "advance" || record.settled_at) throw fail(409, "Only an unsettled paid advance can be settled.");
      const spent = Math.round(Number(req.body.actual_spent) * 100) / 100;
      if (!Number.isFinite(spent) || spent < 0 || spent > record.amount) throw fail(400, "Actual spending must be between zero and the paid amount.");
      if (note.length < 5) throw fail(400, "Enter a settlement note of at least 5 characters.");
      const returned = Math.round((record.amount - spent) * 100) / 100;
      if (returned > 0 && req.body.return_confirmed !== true) throw fail(400, "Confirm the unused money has actually been returned.");
      await recordRequestCost(record, spent, actor, session);
      record.actual_spent = spent; record.returned_amount = returned; record.settled_at = new Date(); record.settled_by = actor; record.settlement_note = note;
      if (returned > 0) await postFinancialTransaction({ propertyId: ctx.propertyId, sourceType: "money_request_return", sourceId: record._id, sourceNumber: record.request_no,
        transactionDate: new Date(), direction: "in", accountingEffect: "neutral", amount: returned, currency: record.currency,
        description: `Unused advance returned for ${record.request_no}. ${note}`, actor, session });
    }
    event(record, action, actor, note); await record.save({ session });
    await audit(record, action, actor, note, session, ctx.property.owner_id); return record;
  });
  res.json({ request: serialize(record) });
}));
router.post("/:id/receipts", wrap(async (req, res) => {
  const before = await context(req), receipt = receiptInput(req.body), actor = actorFromRequest(req);
  const record = await withInventoryTransaction(before.propertyId, async session => {
    const ctx = await context(req, session), record = await read(req, ctx, session);
    if (ctx.role !== "owner" && String(record.requester_id) !== ctx.userId) throw fail(403, "Only the Owner or requester can attach receipts.");
    if (["rejected", "cancelled"].includes(record.status) || record.receipts.length >= 3) throw fail(409, "This request cannot accept more receipts (maximum 3).");
    record.receipts.push({ ...receipt, uploaded_by: actor, uploaded_at: new Date() });
    event(record, "receipt_added", actor, receipt.name); await record.save({ session }); return record;
  });
  res.status(201).json({ request: serialize(record) });
}));
router.get("/:id/receipts/:receiptId", wrap(async (req, res) => {
  const ctx = await context(req), record = await read(req, ctx, null, true);
  const receipt = record.receipts.id(req.params.receiptId);
  if (!receipt) throw fail(404, "Receipt not found.");
  res.set({ "Content-Type": receipt.content_type, "Content-Disposition": `attachment; filename="${receipt.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
  res.send(receipt.data);
}));
async function read(req, ctx, session = null, binary = false) {
  ctx ||= await context(req, session);
  if (!mongoose.isValidObjectId(req.params.id)) throw fail(400, "Invalid request ID.");
  const query = Request.findOne({ ...visibleFilter(ctx), _id: req.params.id }).session(session);
  if (binary) query.select("+receipts.data");
  const record = await query; if (!record) throw fail(404, "Money request not found."); return record;
}
async function audit(record, action, actor, note, session, ownerId) {
  await writeAuditLog({ propertyId: record.property_id, entityType: "money_request", entityId: record._id, action, description: `${record.request_no}: ${action}. ${note}`, actor, session });
  await require("../db_models/money-request-event.model").create([{
    property_id: record.property_id, request_id: record._id, request_no: record.request_no,
    action, version: record.__v || 0, title: `${record.request_no}: ${action}`,
    message: `${record.requester.name} · ${record.currency} ${record.amount.toFixed(2)} · ${record.purpose}`,
    audience_ids: [...new Set([String(ownerId), String(record.requester_id)].filter(id => mongoose.isValidObjectId(id)))]
  }], { session });
}
router.use((error, _req, res, _next) => {
  if (error.name === "ValidationError" || error.name === "CastError") return res.status(400).json({ message: "Check the request details.", errors: Object.values(error.errors || {}).map(e => e.message) });
  if (error.name === "VersionError" || error.code === 11000) return res.status(409).json({ message: "This request changed. Refresh before trying again." });
  if (!error.statusCode) console.error(error);
  res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Money request could not be saved." });
});
module.exports = router;
