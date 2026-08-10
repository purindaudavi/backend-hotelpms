const express = require("express");
const mongoose = require("mongoose");
const Refund = require("../db_models/refund.model");
const Invoice = require("../db_models/invoice.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const { actorFromRequest, changesFromPayload, writeAuditLog } = require("../services/booking-audit.service");
const {
  nextDocumentNumber,
  refreshInvoiceBalances,
  refreshReservationPaidTotal,
  serializeFinancialDocument
} = require("../services/financial-document.service");

const router = express.Router();
const EDITABLE_FIELDS = ["amount", "refund_method", "reference_number", "reason", "notes"];

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };
  const status = normalizeEnum(req.query.status);
  if (status && status !== "all") query.status = status;
  if (req.query.invoice_id) query.invoice_id = objectId(req.query.invoice_id, "invoice_id");
  if (req.query.payment_id) query.payment_id = objectId(req.query.payment_id, "payment_id");
  if (req.query.reservation_id) query.reservation_id = objectId(req.query.reservation_id, "reservation_id");
  if (req.query.guest_id) query.guest_id = objectId(req.query.guest_id, "guest_id");
  if (req.query.date_from || req.query.date_to) query.requested_at = {};
  if (req.query.date_from) query.requested_at.$gte = parseDate(req.query.date_from, "date_from");
  if (req.query.date_to) query.requested_at.$lte = endOfDay(req.query.date_to, "date_to");

  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { refund_no: pattern },
      { invoice_no: pattern },
      { reservation_no: pattern },
      { reference_number: pattern },
      { reason: pattern }
    ];
  }

  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const [refunds, total] = await Promise.all([
    Refund.find(query).sort({ requested_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Refund.countDocuments(query)
  ]);
  return res.status(200).json({
    count: refunds.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    refunds: refunds.map(serializeFinancialDocument)
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const result = await inTransaction(async (session) => {
    const invoice = await Invoice.findOne({
      _id: objectId(req.body?.invoice_id, "invoice_id"),
      property_id: propertyId
    }).session(session);
    if (!invoice) throw notFound("Invoice not found.");
    requireRefundableInvoice(invoice);

    const payment = await ReservationPayment.findOne({
      _id: objectId(req.body?.payment_id, "payment_id"),
      property_id: propertyId,
      invoice_id: invoice._id
    }).session(session);
    if (!payment) throw notFound("The original payment was not found on this invoice.");
    requireRefundablePayment(payment, invoice);

    await refreshInvoiceBalances(invoice, session);
    const amount = positiveMoney(req.body?.amount, "amount");
    await validateRefundAmount({ invoice, payment, amount, session });
    const requestedAt = req.body?.requested_at
      ? parseDate(req.body.requested_at, "requested_at")
      : new Date();
    const refundNo = await nextDocumentNumber({ propertyId, documentType: "refund", date: requestedAt, session });

    const [refund] = await Refund.create([{
      property_id: propertyId,
      refund_no: refundNo,
      invoice_id: invoice._id,
      invoice_no: invoice.invoice_no,
      payment_id: payment._id,
      reservation_id: invoice.reservation_id,
      reservation_no: invoice.reservation_no,
      guest_id: invoice.guest_id,
      amount,
      currency: invoice.currency,
      refund_method: req.body?.refund_method,
      reference_number: req.body?.reference_number,
      reason: req.body?.reason,
      notes: req.body?.notes,
      status: "pending",
      requested_at: requestedAt,
      requested_by: actor,
      updated_by: actor
    }], { session });

    await Promise.all([
      writeRefundLog({
        refund,
        action: "refund_requested",
        description: `Refund ${refund.refund_no} was requested for ${refund.currency} ${refund.amount.toFixed(2)}.`,
        actor, req, session
      }),
      writeInvoiceLog({
        invoice,
        action: "invoice_refund_requested",
        description: `Refund ${refund.refund_no} was requested against invoice ${invoice.invoice_no}.`,
        actor, req, session
      })
    ]);
    return { refund, invoice, payment };
  });

  return res.status(201).json({
    message: `Refund ${result.refund.refund_no} created and is pending completion.`,
    refund: serializeFinancialDocument(result.refund),
    invoice: serializeFinancialDocument(result.invoice),
    payment: result.payment
  });
}));

router.get("/:refundId", asyncHandler(async (req, res) => {
  const refund = await findRefund(req);
  if (!refund) throw notFound("Refund not found.");
  const [invoice, payment, logs] = await Promise.all([
    Invoice.findOne({ _id: refund.invoice_id, property_id: refund.property_id }),
    ReservationPayment.findOne({ _id: refund.payment_id, property_id: refund.property_id }),
    BookingAuditLog.find({ property_id: refund.property_id, entity_type: "refund", entity_id: refund._id })
      .sort({ created_at: -1 })
  ]);
  return res.status(200).json({
    refund: serializeFinancialDocument(refund),
    invoice: invoice ? serializeFinancialDocument(invoice) : null,
    payment,
    logs
  });
}));

router.patch("/:refundId", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const refund = await inTransaction(async (session) => {
    const record = await findRefund(req, session);
    if (!record) throw notFound("Refund not found.");
    if (record.status !== "pending") throw conflict("Only a pending refund can be edited.");
    const [invoice, payment] = await Promise.all([
      Invoice.findOne({ _id: record.invoice_id, property_id: record.property_id }).session(session),
      ReservationPayment.findOne({ _id: record.payment_id, property_id: record.property_id }).session(session)
    ]);
    if (!invoice) throw notFound("Invoice not found.");
    if (!payment) throw notFound("Original payment not found.");
    requireRefundableInvoice(invoice);
    requireRefundablePayment(payment, invoice);
    await refreshInvoiceBalances(invoice, session);

    const before = record.toObject();
    applyFields(record, req.body || {}, EDITABLE_FIELDS);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "amount")) {
      record.amount = positiveMoney(req.body.amount, "amount");
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "refund_method")) {
      record.refund_method = normalizeEnum(req.body.refund_method);
    }
    record.updated_by = actor;
    await record.validate();
    await validateRefundAmount({ invoice, payment, amount: record.amount, excludeRefundId: record._id, session });
    await record.save({ session });
    await writeRefundLog({
      refund: record,
      action: "refund_updated",
      description: `Pending refund ${record.refund_no} was updated.`,
      actor,
      changes: changesFromPayload(before, record.toObject(), EDITABLE_FIELDS),
      req,
      session
    });
    return record;
  });

  return res.status(200).json({
    message: `Refund ${refund.refund_no} updated successfully.`,
    refund: serializeFinancialDocument(refund)
  });
}));

router.post("/:refundId/complete", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const result = await inTransaction(async (session) => {
    const refund = await findRefund(req, session);
    if (!refund) throw notFound("Refund not found.");
    if (refund.status !== "pending") throw conflict("Only a pending refund can be completed.");
    const [invoice, payment] = await Promise.all([
      Invoice.findOne({ _id: refund.invoice_id, property_id: refund.property_id }).session(session),
      ReservationPayment.findOne({ _id: refund.payment_id, property_id: refund.property_id }).session(session)
    ]);
    if (!invoice) throw notFound("Invoice not found.");
    if (!payment) throw notFound("Original payment not found.");
    requireRefundableInvoice(invoice);
    requireRefundablePayment(payment, invoice);
    await refreshInvoiceBalances(invoice, session);
    await validateRefundAmount({
      invoice,
      payment,
      amount: refund.amount,
      excludeRefundId: refund._id,
      session
    });

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "reference_number")) {
      refund.reference_number = req.body.reference_number;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "notes")) refund.notes = req.body.notes;
    refund.status = "completed";
    refund.completed_at = new Date();
    refund.completed_by = actor;
    refund.updated_by = actor;
    await refund.save({ session });
    await refreshInvoiceBalances(invoice, session);
    await refreshReservationPaidTotal(invoice.reservation_id, invoice.property_id, session);
    await Promise.all([
      writeRefundLog({
        refund,
        action: "refund_completed",
        description: `Refund ${refund.refund_no} was completed for ${refund.currency} ${refund.amount.toFixed(2)}.`,
        actor, req, session
      }),
      writeInvoiceLog({
        invoice,
        action: "invoice_refund_completed",
        description: `Refund ${refund.refund_no} was completed against invoice ${invoice.invoice_no}.`,
        actor, req, session
      })
    ]);
    return { refund, invoice, payment };
  });

  return res.status(200).json({
    message: `Refund ${result.refund.refund_no} completed successfully.`,
    refund: serializeFinancialDocument(result.refund),
    invoice: serializeFinancialDocument(result.invoice),
    payment: result.payment
  });
}));

router.post("/:refundId/void", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw badRequest("Void reason is required.");
  const actor = actorFromRequest(req);
  const result = await inTransaction(async (session) => {
    const refund = await findRefund(req, session);
    if (!refund) throw notFound("Refund not found.");
    if (refund.status === "voided") throw conflict("This refund is already voided.");
    const wasCompleted = refund.status === "completed";
    const invoice = await Invoice.findOne({
      _id: refund.invoice_id,
      property_id: refund.property_id
    }).session(session);
    if (!invoice) throw notFound("Invoice not found.");

    refund.status = "voided";
    refund.void_reason = reason;
    refund.voided_at = new Date();
    refund.voided_by = actor;
    refund.updated_by = actor;
    await refund.save({ session });
    if (wasCompleted) {
      await refreshInvoiceBalances(invoice, session);
      await refreshReservationPaidTotal(invoice.reservation_id, invoice.property_id, session);
    }
    await Promise.all([
      writeRefundLog({
        refund,
        action: "refund_voided",
        description: `Refund ${refund.refund_no} was voided: ${reason}`,
        actor, req, session
      }),
      writeInvoiceLog({
        invoice,
        action: "invoice_refund_voided",
        description: `Refund ${refund.refund_no} was voided for invoice ${invoice.invoice_no}.`,
        actor, req, session
      })
    ]);
    return { refund, invoice };
  });

  return res.status(200).json({
    message: `Refund ${result.refund.refund_no} voided successfully.`,
    refund: serializeFinancialDocument(result.refund),
    invoice: serializeFinancialDocument(result.invoice)
  });
}));

router.use(financialErrorHandler);

async function validateRefundAmount({ invoice, payment, amount, excludeRefundId, session }) {
  const exclusion = excludeRefundId ? { _id: { $ne: excludeRefundId } } : {};
  const [pendingForInvoice, committedForPayment] = await Promise.all([
    Refund.find({
      property_id: invoice.property_id,
      invoice_id: invoice._id,
      status: "pending",
      ...exclusion
    }).session(session),
    Refund.find({
      property_id: invoice.property_id,
      payment_id: payment._id,
      status: { $in: ["pending", "completed"] },
      ...exclusion
    }).session(session)
  ]);
  const pendingAmount = money(pendingForInvoice.reduce((total, refund) => total + refund.amount, 0));
  const paymentCommitted = money(committedForPayment.reduce((total, refund) => total + refund.amount, 0));
  const invoiceAvailable = money(Math.max(invoice.refund_due - pendingAmount, 0));
  const paymentAvailable = money(Math.max(payment.amount - paymentCommitted, 0));
  const available = money(Math.min(invoiceAvailable, paymentAvailable));
  if (amount > available) {
    throw conflict(`Refund cannot exceed the available refundable amount of ${invoice.currency} ${available.toFixed(2)}.`);
  }
}

function requireRefundableInvoice(invoice) {
  if (invoice.status === "draft") throw conflict("Issue the invoice before creating a refund.");
  if (invoice.status === "voided") throw conflict("A voided invoice cannot receive a refund.");
}

function requireRefundablePayment(payment, invoice) {
  if (payment.status !== "posted") throw conflict("Only a posted payment can be refunded.");
  if (payment.currency !== invoice.currency) throw conflict("Payment currency does not match the invoice currency.");
}

async function findRefund(req, session) {
  return Refund.findOne({
    _id: objectId(req.params.refundId, "refundId"),
    property_id: requirePropertyId(req)
  }).session(session || null);
}

function writeRefundLog({ refund, action, description, actor, changes = [], req, session }) {
  return writeAuditLog({
    propertyId: refund.property_id,
    entityType: "refund",
    entityId: refund._id,
    action,
    description,
    actor,
    changes,
    requestId: requestId(req),
    session
  });
}

function writeInvoiceLog({ invoice, action, description, actor, req, session }) {
  return writeAuditLog({
    propertyId: invoice.property_id,
    entityType: "invoice",
    entityId: invoice._id,
    action,
    description,
    actor,
    requestId: requestId(req),
    session
  });
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

function applyFields(target, payload, fields) {
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) target[field] = payload[field];
  });
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
  const date = new Date(String(value));
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

function requestId(req) {
  return String(req.get("x-request-id") || "").trim();
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

function financialErrorHandler(error, _req, res, _next) {
  if (error.code === 11000) return res.status(409).json({ message: "That refund number or reference already exists." });
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError || error.name === "BSONError") {
    return res.status(400).json({
      message: "Refund data validation failed.",
      errors: Object.values(error.errors || {}).map((item) => item.message)
    });
  }
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: "The refund request could not be completed." });
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
