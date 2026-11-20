const express = require("express");
const mongoose = require("mongoose");
const { withInventoryTransaction } = require("../services/inventory-transaction.service");
const Invoice = require("../db_models/invoice.model");
const CreditNote = require("../db_models/credit-note.model");
const Refund = require("../db_models/refund.model");
const Reservation = require("../db_models/booking.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const Guest = require("../db_models/guest.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const { actorFromRequest, changesFromPayload, writeAuditLog } = require("../services/booking-audit.service");
const {
  buildAccommodationLines,
  nextDocumentNumber,
  refreshInvoiceBalances,
  refreshReservationPaidTotal,
  serializeFinancialDocument
} = require("../services/financial-document.service");
const {
  postFinancialTransaction,
  voidFinancialTransaction
} = require("../services/financial-transaction.service");
const {
  isStayCharge, stayInvoices, linkedInvoices, getStayExtensionPlan, listPendingStayExtensions,
  sameExtension, canIssueStayExtension
} = require("../services/stay-extension-invoice.service");

const router = express.Router();
const BILLED_STAY_STATUSES = ["issued", "partially_paid", "paid"];
const INVOICEABLE_STAY_STATUSES = ["tentative", "confirmed", "checked_in", "checked_out"];

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
  const override = req.body?.stay_override;
  let overrideReason, originalId;
  if (override !== undefined) {
    requireStayOverrideOwner(req);
    overrideReason = typeof override?.reason === "string" ? override.reason.trim() : "";
    if (override?.confirmed !== true || !overrideReason || overrideReason.length > 500) {
      throw badRequest("Confirm the additional full-stay charge and enter a reason of up to 500 characters.");
    }
    originalId = objectId(override.invoice_id, "stay_override.invoice_id");
    if (Object.hasOwn(req.body, "line_items") || Object.hasOwn(req.body, "additional_line_items")) {
      throw badRequest("An additional full-stay invoice uses the charges from the saved reservation.");
    }
  }
  const invoice = await inTransaction(req, async (session) => {
    const reservationId = objectId(req.body?.reservation_id, "reservation_id");
    const reservation = await Reservation.findOne({
      _id: reservationId,
      property_id: propertyId,
      deleted_at: { $exists: false }
    }).session(session);
    if (!reservation) throw notFound("Reservation not found.");

    let originalInvoice;
    if (override) {
      const invoices = await linkedInvoices(reservation, session);
      originalInvoice = findOverrideOriginal(invoices, originalId);
      if (!originalInvoice || !INVOICEABLE_STAY_STATUSES.includes(reservation.status)) {
        throw conflict("This reservation needs an active issued stay invoice before you can create an additional full-stay invoice.");
      }
      const draft = invoices.find((item) => item.stay_override && item.status === "draft");
      if (draft) throw conflict(`Open the existing additional draft ${draft.invoice_no} before creating another.`);
    }

    const guestId = req.body?.guest_id || reservation.booker?.guest_profile_id;
    if (!guestId) {
      throw badRequest("The reservation must have a saved guest profile before an invoice can be created.");
    }
    const guest = await Guest.findOne({
      _id: objectId(guestId, "guest_id"),
      property_id: propertyId
    }).session(session);
    if (!guest) throw notFound("Guest profile not found.");

    const lineItems = Array.isArray(req.body?.line_items) && req.body.line_items.length
      ? req.body.line_items
      : [
          ...buildAccommodationLines(reservation),
          ...(Array.isArray(req.body?.additional_line_items) ? req.body.additional_line_items : [])
        ];
    if (!originalInvoice && lineItems.some(isStayCharge) && stayInvoices(await linkedInvoices(reservation, session)).some((invoice) => invoice.status !== "credited")) {
      throw conflict("This stay already has an invoice. For extra nights, use the pending stay extension in Financials 2.");
    }
    const invoiceDate = req.body?.invoice_date
      ? parseDate(req.body.invoice_date, "invoice_date")
      : new Date();
    const invoiceNo = await nextDocumentNumber({
      propertyId,
      documentType: "invoice",
      date: invoiceDate,
      session
    });

    const [created] = await Invoice.create([{
      property_id: propertyId,
      invoice_no: invoiceNo,
      ...(originalInvoice && { stay_override: { invoice_id: originalInvoice._id, invoice_no: originalInvoice.invoice_no, reason: overrideReason } }),
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
      action: originalInvoice ? "invoice_stay_override_draft_created" : "invoice_created",
      description: originalInvoice
        ? `Additional full-stay draft ${created.invoice_no} was created for ${created.reservation_no}, already billed on ${originalInvoice.invoice_no}. Reason: ${overrideReason}`
        : `Draft invoice ${created.invoice_no} was created for reservation ${created.reservation_no}.`,
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

router.get("/stay-extensions", asyncHandler(async (req, res) => {
  const extensions = await listPendingStayExtensions(requirePropertyId(req));
  res.set("Cache-Control", "private, no-store");
  return res.json({ extensions });
}));

router.post("/stay-extensions", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const reservationId = objectId(req.body?.reservation_id, "reservation_id");
  const expected = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expected.from_date || "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(expected.to_date || "") ||
      !/^[A-Z]{3}$/.test(expected.currency || "") ||
      !Number.isFinite(expected.amount) || expected.amount <= 0) {
    throw badRequest("Select the saved stay extension and check its amount before creating the draft.");
  }
  const actor = actorFromRequest(req);
  const result = await inTransaction(req, async (session) => {
    const reservation = await Reservation.findOne({
      _id: reservationId, property_id: propertyId, deleted_at: { $exists: false }
    }).session(session);
    if (!reservation) throw notFound("Reservation not found.");
    const invoices = await linkedInvoices(reservation, session);
    const existing = invoices.find((invoice) => sameExtension(invoice, expected));
    if (existing) return { invoice: existing, created: false };

    const plan = getStayExtensionPlan(reservation, invoices);
    if (!plan || ["from_date", "to_date", "currency", "amount"].some((field) => expected[field] !== plan.preview[field])) {
      throw conflict("The unbilled stay dates or amount changed. Refresh and review the booking before creating a draft.");
    }
    const { original, lines, preview } = plan;
    const invoiceDate = new Date();
    const invoiceNo = await nextDocumentNumber({ propertyId, documentType: "invoice", date: invoiceDate, session });
    const [invoice] = await Invoice.create([{
      property_id: propertyId,
      invoice_no: invoiceNo,
      extension_of: original._id,
      reservation_id: reservation._id,
      reservation_no: reservation.reservation_no,
      guest_id: original.guest_id,
      billing_type: original.billing_type,
      billing_snapshot: original.billing_snapshot,
      stay_snapshot: {
        check_in: preview.from_date,
        check_out: preview.to_date,
        nights: preview.nights,
        room_numbers: reservation.rooms.map((room) => room.room_number).filter(Boolean)
      },
      invoice_date: invoiceDate,
      due_date: invoiceDate,
      currency: preview.currency,
      line_items: lines,
      status: "draft",
      notes: `Stay extension for ${reservation.reservation_no}. Original invoice ${original.invoice_no}.`,
      created_by: actor,
      updated_by: actor
    }], { session });
    await writeInvoiceLog({ invoice, action: "invoice_created", actor, req, session,
      description: `Draft invoice ${invoice.invoice_no} created for the added nights of ${reservation.reservation_no}.` });
    return { invoice, created: true };
  });
  return res.status(result.created ? 201 : 200).json({
    message: result.created ? "Stay extension draft created." : "This stay extension already has an invoice.",
    invoice: serializeFinancialDocument(result.invoice)
  });
}));

router.get("/:invoiceId", asyncHandler(async (req, res) => {
  const invoice = await findInvoice(req);
  if (!invoice) throw notFound("Invoice not found.");
  const [payments, credits, refunds, logs] = await Promise.all([
    ReservationPayment.find({ property_id: invoice.property_id, invoice_id: invoice._id }).sort({ posted_at: -1 }),
    CreditNote.find({ property_id: invoice.property_id, invoice_id: invoice._id }).sort({ credit_date: -1 }),
    Refund.find({ property_id: invoice.property_id, invoice_id: invoice._id }).sort({ requested_at: -1 }),
    BookingAuditLog.find({ property_id: invoice.property_id, entity_type: "invoice", entity_id: invoice._id }).sort({ created_at: -1 })
  ]);
  return res.status(200).json({
    invoice: serializeFinancialDocument(invoice),
    payments,
    credits: credits.map(serializeFinancialDocument),
    refunds: refunds.map(serializeFinancialDocument),
    logs
  });
}));

router.patch("/:invoiceId", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const invoice = await inTransaction(req, async (session) => {
    const record = await findInvoice(req, session);
    if (!record) throw notFound("Invoice not found.");
    if (record.status !== "draft") {
      throw conflict("Only a draft invoice can be edited. Use a credit note to correct an issued invoice.");
    }
    if (record.stay_override) requireStayOverrideOwner(req);
    if ((record.extension_of || record.stay_override) && Object.hasOwn(req.body || {}, "line_items")) {
      throw conflict("The charges on this draft come from the reservation. Void the draft and recreate it if the stay changes.");
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
  const invoice = await inTransaction(req, async (session) => {
    const record = await findInvoice(req, session);
    if (!record) throw notFound("Invoice not found.");
    if (record.status !== "draft") throw conflict("Only a draft invoice can be issued.");
    if (record.grand_total <= 0) throw conflict("A zero-value invoice cannot be issued.");
    if (record.stay_override) {
      requireStayOverrideOwner(req);
      if (req.body?.confirm_stay_override !== true) throw badRequest("Confirm the additional full-stay charge before issuing this invoice.");
      const reservation = await Reservation.findOne({
        _id: record.reservation_id, property_id: record.property_id, deleted_at: { $exists: false }
      }).session(session);
      if (!reservation || !INVOICEABLE_STAY_STATUSES.includes(reservation.status) ||
          !matchesSavedStay(record, reservation) ||
          !findOverrideOriginal(await linkedInvoices(reservation, session), record.stay_override.invoice_id)) {
        throw conflict("The stay or its original invoice has changed. Review the reservation and recreate this draft if needed.");
      }
    } else if (record.extension_of) {
      const reservation = await Reservation.findOne({
        _id: record.reservation_id, property_id: record.property_id, deleted_at: { $exists: false }
      }).session(session);
      if (!reservation || !canIssueStayExtension(reservation, await linkedInvoices(reservation, session), record)) {
        throw conflict("This draft no longer matches the stay or its linked invoices. Review the reservation and recreate the draft.");
      }
    } else if (record.line_items.some(isStayCharge)) {
      const invoices = await linkedInvoices({ property_id: record.property_id, _id: record.reservation_id }, session);
      if (stayInvoices(invoices).some((invoice) => !invoice.extension_of && !["draft", "credited"].includes(invoice.status))) {
        throw conflict("This stay already has an issued invoice. Use a stay extension invoice for additional nights.");
      }
    }
    record.status = "issued";
    record.issued_by = actor;
    record.issued_at = new Date();
    record.updated_by = actor;
    await record.save({ session });
    await postFinancialTransaction({
      propertyId: record.property_id,
      sourceType: "invoice",
      sourceId: record._id,
      sourceNumber: record.invoice_no,
      transactionDate: record.issued_at,
      direction: "non_cash",
      accountingEffect: "increase",
      amount: record.grand_total,
      currency: record.currency,
      reservationId: record.reservation_id,
      reservationNo: record.reservation_no,
      roomNumbers: record.stay_snapshot?.room_numbers || [],
      description: record.stay_override
        ? `Additional full-stay invoice ${record.invoice_no} issued to ${record.billing_snapshot?.name || "guest"}.`
        : `Invoice ${record.invoice_no} issued to ${record.billing_snapshot?.name || "guest"}.`,
      actor,
      requestId: requestId(req),
      session
    });
    await writeInvoiceLog({
      invoice: record,
      action: record.stay_override ? "invoice_stay_override_issued" : "invoice_issued",
      description: record.stay_override
        ? `Additional full-stay invoice ${record.invoice_no} was issued for ${record.currency} ${record.grand_total.toFixed(2)}. Original invoice ${record.stay_override.invoice_no}. Reason: ${record.stay_override.reason}`
        : `Invoice ${record.invoice_no} was issued for ${record.currency} ${record.grand_total.toFixed(2)}.`,
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
  const invoice = await inTransaction(req, async (session) => {
    const record = await findInvoice(req, session);
    if (!record) throw notFound("Invoice not found.");
    if (record.status === "voided") throw conflict("This invoice is already voided.");
    const [paymentCount, creditCount, refundCount] = await Promise.all([
      ReservationPayment.countDocuments({ invoice_id: record._id, status: { $ne: "voided" } }).session(session),
      CreditNote.countDocuments({ invoice_id: record._id, status: "issued" }).session(session),
      Refund.countDocuments({ invoice_id: record._id, status: { $ne: "voided" } }).session(session)
    ]);
    if (paymentCount || creditCount || refundCount) {
      throw conflict("Void the invoice payments, issued credit notes, and refunds before voiding this invoice.");
    }
    record.status = "voided";
    record.void_reason = reason;
    record.voided_by = actor;
    record.voided_at = new Date();
    record.updated_by = actor;
    await record.save({ session });
    await voidFinancialTransaction({
      propertyId: record.property_id,
      sourceType: "invoice",
      sourceId: record._id,
      reason,
      actor,
      requestId: requestId(req),
      voidedAt: record.voided_at,
      session
    });
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
  const result = await inTransaction(req, async (session) => {
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
    await postFinancialTransaction({
      propertyId: invoice.property_id,
      sourceType: "payment",
      sourceId: payment._id,
      sourceNumber: invoice.invoice_no,
      transactionDate: payment.posted_at,
      direction: "in",
      accountingEffect: "increase",
      amount: payment.amount,
      currency: payment.currency,
      reservationId: invoice.reservation_id,
      reservationNo: invoice.reservation_no,
      roomNumbers: invoice.stay_snapshot?.room_numbers || [],
      description: `Payment received against invoice ${invoice.invoice_no}.`,
      actor,
      requestId: requestId(req),
      session
    });
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
  const result = await inTransaction(req, async (session) => {
    const invoice = await findInvoice(req, session);
    if (!invoice) throw notFound("Invoice not found.");
    const payment = await ReservationPayment.findOne({
      _id: objectId(req.params.paymentId, "paymentId"),
      property_id: invoice.property_id,
      invoice_id: invoice._id
    }).session(session);
    if (!payment) throw notFound("Invoice payment not found.");
    if (payment.status === "voided") throw conflict("This payment is already voided.");
    const refundCount = await Refund.countDocuments({
      property_id: invoice.property_id,
      payment_id: payment._id,
      status: { $ne: "voided" }
    }).session(session);
    if (refundCount) throw conflict("Void refunds linked to this payment before voiding the payment.");
    payment.status = "voided";
    payment.void_reason = reason;
    payment.voided_by = actor;
    payment.voided_at = new Date();
    await payment.save({ session });
    await voidFinancialTransaction({
      propertyId: invoice.property_id,
      sourceType: "payment",
      sourceId: payment._id,
      reason,
      actor,
      requestId: requestId(req),
      voidedAt: payment.voided_at,
      session
    });
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

function requireStayOverrideOwner(req) {
  if (req.propertyRole !== "owner") throw httpError(403, "Only the property Owner can create or issue an additional full-stay invoice.");
}

function findOverrideOriginal(invoices, invoiceId) {
  return stayInvoices(invoices).find((invoice) => String(invoice._id) === String(invoiceId) &&
    !invoice.extension_of && !invoice.stay_override && BILLED_STAY_STATUSES.includes(invoice.status));
}

function matchesSavedStay(invoice, reservation) {
  const snapshot = invoice.stay_snapshot;
  const fields = ["source_type", "source_id", "service_date", "room_number", "quantity", "unit_price", "discount_amount", "tax_rate"];
  const charges = (lines) => lines.map((line) => JSON.stringify(fields.map((field) => line[field] ?? ""))).sort();
  return invoice.currency === reservation.currency &&
    Number(snapshot.check_in) === Number(reservation.check_in) &&
    Number(snapshot.check_out) === Number(reservation.check_out) &&
    Boolean(snapshot.is_day_room) === Boolean(reservation.is_day_room) &&
    JSON.stringify(charges(invoice.line_items)) === JSON.stringify(charges(buildAccommodationLines(reservation)));
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

function requestId(req) {
  return String(req.get("x-request-id") || "").trim();
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

function inTransaction(req, work) {
  return withInventoryTransaction(requirePropertyId(req), work);
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
