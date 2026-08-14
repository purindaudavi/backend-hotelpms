const express = require("express");
const mongoose = require("mongoose");
const CreditNote = require("../db_models/credit-note.model");
const Invoice = require("../db_models/invoice.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const { actorFromRequest, changesFromPayload, writeAuditLog } = require("../services/booking-audit.service");
const {
  nextDocumentNumber,
  refreshInvoiceBalances,
  serializeFinancialDocument
} = require("../services/financial-document.service");
const {
  postFinancialTransaction,
  voidFinancialTransaction
} = require("../services/financial-transaction.service");

const router = express.Router();
const DRAFT_EDIT_FIELDS = ["credit_date", "reason_code", "reason", "line_items", "notes"];

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };
  const status = normalizeEnum(req.query.status);
  if (status && status !== "all") query.status = status;
  if (req.query.invoice_id) query.invoice_id = objectId(req.query.invoice_id, "invoice_id");
  if (req.query.reservation_id) query.reservation_id = objectId(req.query.reservation_id, "reservation_id");
  if (req.query.guest_id) query.guest_id = objectId(req.query.guest_id, "guest_id");
  if (req.query.date_from || req.query.date_to) query.credit_date = {};
  if (req.query.date_from) query.credit_date.$gte = parseDate(req.query.date_from, "date_from");
  if (req.query.date_to) query.credit_date.$lte = endOfDay(req.query.date_to, "date_to");

  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { credit_note_no: pattern },
      { invoice_no: pattern },
      { reservation_no: pattern },
      { "guest_snapshot.name": pattern },
      { reason: pattern }
    ];
  }

  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const [credits, total] = await Promise.all([
    CreditNote.find(query).sort({ credit_date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    CreditNote.countDocuments(query)
  ]);
  return res.status(200).json({
    count: credits.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    credits: credits.map(serializeFinancialDocument)
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
    requireCreditableInvoice(invoice);

    const creditDate = req.body?.credit_date
      ? parseDate(req.body.credit_date, "credit_date")
      : new Date();
    const creditNoteNo = await nextDocumentNumber({
      propertyId,
      documentType: "credit_note",
      date: creditDate,
      session
    });
    const [credit] = await CreditNote.create([{
      property_id: propertyId,
      credit_note_no: creditNoteNo,
      invoice_id: invoice._id,
      invoice_no: invoice.invoice_no,
      reservation_id: invoice.reservation_id,
      reservation_no: invoice.reservation_no,
      guest_id: invoice.guest_id,
      guest_snapshot: {
        name: invoice.billing_snapshot.name,
        email: invoice.billing_snapshot.email,
        phone: invoice.billing_snapshot.phone
      },
      credit_date: creditDate,
      currency: invoice.currency,
      reason_code: normalizeEnum(req.body?.reason_code),
      reason: req.body?.reason,
      line_items: req.body?.line_items,
      status: "draft",
      notes: req.body?.notes,
      created_by: actor,
      updated_by: actor
    }], { session });
    await validateCreditAgainstInvoice(credit, invoice, session);
    await writeCreditLog({
      credit,
      action: "credit_note_created",
      description: `Draft credit note ${credit.credit_note_no} was created for invoice ${invoice.invoice_no}.`,
      actor,
      req,
      session
    });
    return { credit, invoice };
  });
  return res.status(201).json({
    message: `Draft credit note ${result.credit.credit_note_no} created successfully.`,
    credit: serializeFinancialDocument(result.credit),
    invoice: serializeFinancialDocument(result.invoice)
  });
}));

router.get("/:creditNoteId", asyncHandler(async (req, res) => {
  const credit = await findCredit(req);
  if (!credit) throw notFound("Credit note not found.");
  const [invoice, logs] = await Promise.all([
    Invoice.findOne({ _id: credit.invoice_id, property_id: credit.property_id }),
    BookingAuditLog.find({
      property_id: credit.property_id,
      entity_type: "credit_note",
      entity_id: credit._id
    }).sort({ created_at: -1 })
  ]);
  return res.status(200).json({
    credit: serializeFinancialDocument(credit),
    invoice: invoice ? serializeFinancialDocument(invoice) : null,
    logs
  });
}));

router.patch("/:creditNoteId", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const credit = await inTransaction(async (session) => {
    const record = await findCredit(req, session);
    if (!record) throw notFound("Credit note not found.");
    if (record.status !== "draft") throw conflict("Only a draft credit note can be edited.");
    const invoice = await Invoice.findOne({
      _id: record.invoice_id,
      property_id: record.property_id
    }).session(session);
    if (!invoice) throw notFound("Invoice not found.");
    requireCreditableInvoice(invoice);
    const before = record.toObject();
    applyFields(record, req.body || {}, DRAFT_EDIT_FIELDS);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "reason_code")) {
      record.reason_code = normalizeEnum(req.body.reason_code);
    }
    record.updated_by = actor;
    await record.validate();
    await validateCreditAgainstInvoice(record, invoice, session);
    await record.save({ session });
    await writeCreditLog({
      credit: record,
      action: "credit_note_updated",
      description: `Draft credit note ${record.credit_note_no} was updated.`,
      actor,
      changes: changesFromPayload(before, record.toObject(), DRAFT_EDIT_FIELDS),
      req,
      session
    });
    return record;
  });
  return res.status(200).json({
    message: `Draft credit note ${credit.credit_note_no} updated successfully.`,
    credit: serializeFinancialDocument(credit)
  });
}));

router.post("/:creditNoteId/issue", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const result = await inTransaction(async (session) => {
    const credit = await findCredit(req, session);
    if (!credit) throw notFound("Credit note not found.");
    if (credit.status !== "draft") throw conflict("Only a draft credit note can be issued.");
    const invoice = await Invoice.findOne({
      _id: credit.invoice_id,
      property_id: credit.property_id
    }).session(session);
    if (!invoice) throw notFound("Invoice not found.");
    requireCreditableInvoice(invoice);
    await validateCreditAgainstInvoice(credit, invoice, session);

    credit.status = "issued";
    credit.issued_by = actor;
    credit.issued_at = new Date();
    credit.updated_by = actor;
    await credit.save({ session });
    await postFinancialTransaction({
      propertyId: credit.property_id,
      sourceType: "credit_note",
      sourceId: credit._id,
      sourceNumber: credit.credit_note_no,
      transactionDate: credit.issued_at,
      direction: "non_cash",
      accountingEffect: "decrease",
      amount: credit.total_credit,
      currency: credit.currency,
      reservationId: credit.reservation_id,
      reservationNo: credit.reservation_no,
      roomNumbers: invoice.stay_snapshot?.room_numbers || [],
      description: `Credit note ${credit.credit_note_no} reduced invoice ${invoice.invoice_no}: ${credit.reason}`,
      actor,
      requestId: requestId(req),
      session
    });
    await refreshInvoiceBalances(invoice, session);
    await Promise.all([
      writeCreditLog({
        credit,
        action: "credit_note_issued",
        description: `Credit note ${credit.credit_note_no} was issued for ${credit.currency} ${credit.total_credit.toFixed(2)}.`,
        actor,
        req,
        session
      }),
      writeAuditLog({
        propertyId: invoice.property_id,
        entityType: "invoice",
        entityId: invoice._id,
        action: "credit_note_applied",
        description: `Credit note ${credit.credit_note_no} was applied to invoice ${invoice.invoice_no}.`,
        actor,
        requestId: requestId(req),
        session
      })
    ]);
    return { credit, invoice };
  });
  return res.status(200).json({
    message: `Credit note ${result.credit.credit_note_no} issued and applied successfully.`,
    credit: serializeFinancialDocument(result.credit),
    invoice: serializeFinancialDocument(result.invoice)
  });
}));

router.post("/:creditNoteId/void", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw badRequest("Void reason is required.");
  const actor = actorFromRequest(req);
  const result = await inTransaction(async (session) => {
    const credit = await findCredit(req, session);
    if (!credit) throw notFound("Credit note not found.");
    if (credit.status === "voided") throw conflict("This credit note is already voided.");
    const wasIssued = credit.status === "issued";
    const invoice = await Invoice.findOne({
      _id: credit.invoice_id,
      property_id: credit.property_id
    }).session(session);
    if (!invoice) throw notFound("Invoice not found.");

    credit.status = "voided";
    credit.void_reason = reason;
    credit.voided_by = actor;
    credit.voided_at = new Date();
    credit.updated_by = actor;
    await credit.save({ session });
    if (wasIssued) {
      await voidFinancialTransaction({
        propertyId: credit.property_id,
        sourceType: "credit_note",
        sourceId: credit._id,
        reason,
        actor,
        requestId: requestId(req),
        voidedAt: credit.voided_at,
        session
      });
    }
    if (wasIssued) await refreshInvoiceBalances(invoice, session);
    await Promise.all([
      writeCreditLog({
        credit,
        action: "credit_note_voided",
        description: `Credit note ${credit.credit_note_no} was voided: ${reason}`,
        actor,
        req,
        session
      }),
      wasIssued ? writeAuditLog({
        propertyId: invoice.property_id,
        entityType: "invoice",
        entityId: invoice._id,
        action: "credit_note_removed",
        description: `Voided credit note ${credit.credit_note_no} was removed from invoice ${invoice.invoice_no}.`,
        actor,
        requestId: requestId(req),
        session
      }) : Promise.resolve()
    ]);
    return { credit, invoice };
  });
  return res.status(200).json({
    message: `Credit note ${result.credit.credit_note_no} voided successfully.`,
    credit: serializeFinancialDocument(result.credit),
    invoice: serializeFinancialDocument(result.invoice)
  });
}));

router.use(financialErrorHandler);

async function validateCreditAgainstInvoice(credit, invoice, session) {
  if (credit.currency !== invoice.currency) throw badRequest("Credit currency must match the invoice currency.");
  const issuedCredits = await CreditNote.find({
    property_id: invoice.property_id,
    invoice_id: invoice._id,
    status: "issued",
    _id: { $ne: credit._id }
  }).session(session);
  const alreadyCredited = issuedCredits.reduce((total, item) => total + item.total_credit, 0);
  const remaining = money(invoice.grand_total - alreadyCredited);
  if (credit.total_credit > remaining) {
    throw conflict(`Credit note cannot exceed the remaining creditable amount of ${invoice.currency} ${remaining.toFixed(2)}.`);
  }

  const invoiceLines = new Map(invoice.line_items.map((line) => [String(line._id), line]));
  const alreadyCreditedByLine = new Map();
  issuedCredits.forEach((item) => item.line_items.forEach((line) => {
    if (!line.invoice_line_id) return;
    const key = String(line.invoice_line_id);
    alreadyCreditedByLine.set(key, money((alreadyCreditedByLine.get(key) || 0) + line.total_amount));
  }));
  const creditingNowByLine = new Map();
  for (const line of credit.line_items) {
    if (!line.invoice_line_id) continue;
    const key = String(line.invoice_line_id);
    const invoiceLine = invoiceLines.get(key);
    if (!invoiceLine) throw badRequest("Every invoice_line_id must belong to the selected invoice.");
    const lineRemaining = money(invoiceLine.total_amount - (alreadyCreditedByLine.get(key) || 0));
    const creditingNow = money((creditingNowByLine.get(key) || 0) + line.total_amount);
    creditingNowByLine.set(key, creditingNow);
    if (creditingNow > lineRemaining) {
      throw conflict(`Credit for ${invoiceLine.description} cannot exceed ${invoice.currency} ${lineRemaining.toFixed(2)}.`);
    }
  }
}

function requireCreditableInvoice(invoice) {
  if (invoice.status === "draft") throw conflict("Issue the invoice before creating a credit note.");
  if (invoice.status === "voided") throw conflict("A voided invoice cannot receive a credit note.");
  if (invoice.status === "credited") throw conflict("This invoice has already been fully credited.");
}

async function findCredit(req, session) {
  return CreditNote.findOne({
    _id: objectId(req.params.creditNoteId, "creditNoteId"),
    property_id: requirePropertyId(req)
  }).session(session || null);
}

function writeCreditLog({ credit, action, description, actor, changes = [], req, session }) {
  return writeAuditLog({
    propertyId: credit.property_id,
    entityType: "credit_note",
    entityId: credit._id,
    action,
    description,
    actor,
    changes,
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
  if (error.code === 11000) return res.status(409).json({ message: "That credit note number already exists." });
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError || error.name === "BSONError") {
    return res.status(400).json({
      message: "Credit note data validation failed.",
      errors: Object.values(error.errors || {}).map((item) => item.message)
    });
  }
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: "The credit note request could not be completed." });
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
