const express = require("express");
const mongoose = require("mongoose");
const Invoice = require("../db_models/invoice.model");
const CreditNote = require("../db_models/credit-note.model");
const Reservation = require("../db_models/booking.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const Guest = require("../db_models/guest.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const { actorFromRequest, changesFromPayload, writeAuditLog } = require("../services/booking-audit.service");
const {
  buildAccommodationLines,
  nextDocumentNumber,
  refreshInvoiceBalances,
  serializeFinancialDocument
} = require("../services/financial-document.service");

const router = express.Router();

const DRAFT_EDIT_FIELDS = [
  "reference_number",
  "due_date",
  "billing_type",
  "billing_snapshot",
  "line_items",
  "notes",
  "terms"
];

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = { property_id: propertyId };
  const status = normalizeEnum(req.query.status);
  if (status && status !== "all") query.status = status;
  if (req.query.reservation_id) query.reservation_id = objectId(req.query.reservation_id, "reservation_id");
  if (req.query.guest_id) query.guest_id = objectId(req.query.guest_id, "guest_id");
  if (req.query.date_from || req.query.date_to) query.invoice_date = {};
  if (req.query.date_from) query.invoice_date.$gte = parseDate(req.query.date_from, "date_from");
  if (req.query.date_to) query.invoice_date.$lte = endOfDay(req.query.date_to, "date_to");

  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { invoice_no: pattern },
      { reservation_no: pattern },
      { reference_number: pattern },
      { "billing_snapshot.name": pattern },
      { "billing_snapshot.email": pattern }
    ];
  }

  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const [invoices, total] = await Promise.all([
    Invoice.find(query).sort({ invoice_date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Invoice.countDocuments(query)
  ]);

  return res.status(200).json({
    count: invoices.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    invoices: invoices.map(serializeFinancialDocument)
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const invoice = await inTransaction(async (session) => {
    const reservationId = objectId(req.body?.reservation_id, "reservation_id");
    const reservation = await Reservation.findOne({
      _id: reservationId,
      property_id: propertyId,
      deleted_at: { $exists: false }
    }).session(session);
    if (!reservation) throw notFound("Reservation not found.");

    const guestId = req.body?.guest_id || reservation.booker?.guest_profile_id;
    if (!guestId) {
      throw badRequest("The reservation must have a saved guest profile before an invoice can be created.");
    }
    const guest = await Guest.findOne({
      _id: objectId(guestId, "guest_id"),
      property_id: propertyId
    }).session(session);
    if (!guest) throw notFound("Guest profile not found.");

    const invoiceDate = req.body?.invoice_date
      ? parseDate(req.body.invoice_date, "invoice_date")
      : new Date();
    const invoiceNo = await nextDocumentNumber({
      propertyId,
      documentType: "invoice",
      date: invoiceDate,
      session
    });
    const lineItems = Array.isArray(req.body?.line_items) && req.body.line_items.length
      ? req.body.line_items
      : [
          ...buildAccommodationLines(reservation),
          ...(Array.isArray(req.body?.additional_line_items) ? req.body.additional_line_items : [])
        ];

    const [created] = await Invoice.create([{
      property_id: propertyId,
      invoice_no: invoiceNo,
      reference_number: req.body?.reference_number,
      reservation_id: reservation._id,
      reservation_no: reservation.reservation_no,
      guest_id: guest._id,
      billing_type: req.body?.billing_type || "guest",
      billing_snapshot: {
        name: req.body?.billing_snapshot?.name || guest.name,
        email: req.body?.billing_snapshot?.email ?? guest.email,
        phone: req.body?.billing_snapshot?.phone ?? guest.phone,
        address: req.body?.billing_snapshot?.address,
        country: req.body?.billing_snapshot?.country || guest.country,
        tax_number: req.body?.billing_snapshot?.tax_number
      },
      stay_snapshot: {
        check_in: reservation.check_in,
        check_out: reservation.check_out,
        nights: reservation.is_day_room ? 0 : reservation.nights,
        is_day_room: reservation.is_day_room,
        room_numbers: reservation.rooms.map((room) => room.room_number).filter(Boolean)
      },
      invoice_date: invoiceDate,
      due_date: req.body?.due_date || invoiceDate,
      currency: reservation.currency,
      line_items: lineItems,
      notes: req.body?.notes,
      terms: req.body?.terms,
      status: "draft",
      created_by: actor,
      updated_by: actor
    }], { session });

    await writeInvoiceLog({
      invoice: created,
      action: "invoice_created",
      description: `Draft invoice ${created.invoice_no} was created for reservation ${created.reservation_no}.`,
      actor,
      req,
      session
    });
    return created;
  });

  return res.status(201).json({
    message: `Draft invoice ${invoice.invoice_no} created successfully.`,
    invoice: serializeFinancialDocument(invoice)
  });
}));

router.get("/:invoiceId", asyncHandler(async (req, res) => {
  const invoice = await findInvoice(req);
  if (!invoice) throw notFound("Invoice not found.");
  const [payments, credits, logs] = await Promise.all([
    ReservationPayment.find({ property_id: invoice.property_id, invoice_id: invoice._id }).sort({ posted_at: -1 }),
    CreditNote.find({ property_id: invoice.property_id, invoice_id: invoice._id }).sort({ credit_date: -1 }),
    BookingAuditLog.find({ property_id: invoice.property_id, entity_type: "invoice", entity_id: invoice._id }).sort({ created_at: -1 })
  ]);
  return res.status(200).json({
    invoice: serializeFinancialDocument(invoice),
    payments,
    credits: credits.map(serializeFinancialDocument),
    logs
  });
}));

router.patch("/:invoiceId", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const invoice = await inTransaction(async (session) => {
    const record = await findInvoice(req, session);
    if (!record) throw notFound("Invoice not found.");
    if (record.status !== "draft") {
      throw conflict("Only a draft invoice can be edited. Use a credit note to correct an issued invoice.");
    }
    const before = record.toObject();
    applyFields(record, req.body || {}, DRAFT_EDIT_FIELDS);
    record.updated_by = actor;
    await record.save({ session });
    await writeInvoiceLog({
      invoice: record,
      action: "invoice_updated",
      description: `Draft invoice ${record.invoice_no} was updated.`,
      actor,
      changes: changesFromPayload(before, record.toObject(), DRAFT_EDIT_FIELDS),
      req,
      session
    });
    return record;
  });
  return res.status(200).json({
    message: `Draft invoice ${invoice.invoice_no} updated successfully.`,
    invoice: serializeFinancialDocument(invoice)
  });
}));

router.post("/:invoiceId/issue", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const invoice = await inTransaction(async (session) => {
    const record = await findInvoice(req, session);
    if (!record) throw notFound("Invoice not found.");
    if (record.status !== "draft") throw conflict("Only a draft invoice can be issued.");
    if (record.grand_total <= 0) throw conflict("A zero-value invoice cannot be issued.");
    record.status = "issued";
    record.issued_by = actor;
    record.issued_at = new Date();
    record.updated_by = actor;
    await record.save({ session });
    await writeInvoiceLog({
      invoice: record,
      action: "invoice_issued",
      description: `Invoice ${record.invoice_no} was issued for ${record.currency} ${record.grand_total.toFixed(2)}.`,
      actor,
      req,
      session
    });
    return record;
  });
  return res.status(200).json({
    message: `Invoice ${invoice.invoice_no} issued successfully.`,
    invoice: serializeFinancialDocument(invoice)
  });
}));

router.post("/:invoiceId/void", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw badRequest("Void reason is required.");
  const actor = actorFromRequest(req);
  const invoice = await inTransaction(async (session) => {
    const record = await findInvoice(req, session);
    if (!record) throw notFound("Invoice not found.");
    if (record.status === "voided") throw conflict("This invoice is already voided.");
    const [paymentCount, creditCount] = await Promise.all([
      ReservationPayment.countDocuments({ invoice_id: record._id, status: { $ne: "voided" } }).session(session),
      CreditNote.countDocuments({ invoice_id: record._id, status: "issued" }).session(session)
    ]);
    if (paymentCount || creditCount) {
      throw conflict("Void the invoice payments and issued credit notes before voiding this invoice.");
    }
    record.status = "voided";
    record.void_reason = reason;
    record.voided_by = actor;
    record.voided_at = new Date();
    record.updated_by = actor;
    await record.save({ session });
    await writeInvoiceLog({
      invoice: record,
      action: "invoice_voided",
      description: `Invoice ${record.invoice_no} was voided: ${reason}`,
      actor,
      req,
      session
    });
    return record;
  });
  return res.status(200).json({
    message: `Invoice ${invoice.invoice_no} voided successfully.`,
    invoice: serializeFinancialDocument(invoice)
  });
}));

router.get("/:invoiceId/payments", asyncHandler(async (req, res) => {
  const invoice = await findInvoice(req);
  if (!invoice) throw notFound("Invoice not found.");
  const payments = await ReservationPayment.find({
    property_id: invoice.property_id,
    invoice_id: invoice._id
  }).sort({ posted_at: -1 });
  return res.status(200).json({ count: payments.length, payments });
}));

router.post("/:invoiceId/payments", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const result = await inTransaction(async (session) => {
    const invoice = await findInvoice(req, session);
    if (!invoice) throw notFound("Invoice not found.");
    if (!["issued", "partially_paid"].includes(invoice.status)) {
      throw conflict("Payments can be posted only to an issued invoice with an outstanding balance.");
    }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest("Payment amount must be greater than zero.");
    if (amount > invoice.balance_due) {
      throw conflict(`Payment cannot exceed the outstanding balance of ${invoice.currency} ${invoice.balance_due.toFixed(2)}.`);
    }
    const currency = String(req.body?.currency || invoice.currency).trim().toUpperCase();
    if (currency !== invoice.currency) throw badRequest("Payment currency must match the invoice currency.");
    const [payment] = await ReservationPayment.create([{
      property_id: invoice.property_id,
      reservation_id: invoice.reservation_id,
      invoice_id: invoice._id,
      invoice_no: invoice.invoice_no,
      amount,
      currency,
      payment_method: req.body?.payment_method,
      payment_reference: req.body?.payment_reference,
      status: "posted",
      notes: req.body?.notes,
      posted_by: actor
    }], { session });
    await refreshInvoiceBalances(invoice, session);
    await refreshReservationPaidTotal(invoice.reservation_id, invoice.property_id, session);
    await writeInvoiceLog({
      invoice,
      action: "invoice_payment_posted",
      description: `${currency} ${amount.toFixed(2)} was paid against invoice ${invoice.invoice_no}.`,
      actor,
      req,
      session
    });
    return { invoice, payment };
  });
  return res.status(201).json({
    message: "Invoice payment recorded successfully.",
    invoice: serializeFinancialDocument(result.invoice),
    payment: result.payment
  });
}));

router.post("/:invoiceId/payments/:paymentId/void", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw badRequest("Void reason is required.");
  const actor = actorFromRequest(req);
  const result = await inTransaction(async (session) => {
    const invoice = await findInvoice(req, session);
    if (!invoice) throw notFound("Invoice not found.");
    const payment = await ReservationPayment.findOne({
      _id: objectId(req.params.paymentId, "paymentId"),
      property_id: invoice.property_id,
      invoice_id: invoice._id
    }).session(session);
    if (!payment) throw notFound("Invoice payment not found.");
    if (payment.status === "voided") throw conflict("This payment is already voided.");
    payment.status = "voided";
    payment.void_reason = reason;
    payment.voided_by = actor;
    payment.voided_at = new Date();
    await payment.save({ session });
    await refreshInvoiceBalances(invoice, session);
    await refreshReservationPaidTotal(invoice.reservation_id, invoice.property_id, session);
    await writeInvoiceLog({
      invoice,
      action: "invoice_payment_voided",
      description: `Payment ${payment._id} was voided: ${reason}`,
      actor,
      req,
      session
    });
    return { invoice, payment };
  });
  return res.status(200).json({
    message: "Invoice payment voided successfully.",
    invoice: serializeFinancialDocument(result.invoice),
    payment: result.payment
  });
}));

router.use(financialErrorHandler("invoice"));

async function findInvoice(req, session) {
  return Invoice.findOne({
    _id: objectId(req.params.invoiceId, "invoiceId"),
    property_id: requirePropertyId(req)
  }).session(session || null);
}

async function refreshReservationPaidTotal(reservationId, propertyId, session) {
  const [reservation, payments] = await Promise.all([
    Reservation.findOne({ _id: reservationId, property_id: propertyId }).session(session),
    ReservationPayment.find({
      property_id: propertyId,
      reservation_id: reservationId,
      status: { $in: ["posted", "refunded"] }
    }).session(session)
  ]);
  if (!reservation) return;
  reservation.financial_summary.paid_total = Math.max(payments.reduce(
    (total, payment) => total + (payment.status === "refunded" ? -payment.amount : payment.amount),
    0
  ), 0);
  await reservation.save({ session });
}

function writeInvoiceLog({ invoice, action, description, actor, changes = [], req, session }) {
  return writeAuditLog({
    propertyId: invoice.property_id,
    entityType: "invoice",
    entityId: invoice._id,
    action,
    description,
    actor,
    changes,
    requestId: String(req.get("x-request-id") || "").trim(),
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

function financialErrorHandler(documentName) {
  return (error, _req, res, _next) => {
    if (error.code === 11000) return res.status(409).json({ message: `That ${documentName} number or reference already exists.` });
    if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError || error.name === "BSONError") {
      return res.status(400).json({
        message: `${capitalise(documentName)} data validation failed.`,
        errors: Object.values(error.errors || {}).map((item) => item.message)
      });
    }
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.error(error);
    return res.status(500).json({ message: `The ${documentName} request could not be completed.` });
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function badRequest(message) { return httpError(400, message); }
function notFound(message) { return httpError(404, message); }
function conflict(message) { return httpError(409, message); }
function capitalise(value) { return value.charAt(0).toUpperCase() + value.slice(1); }

module.exports = router;
