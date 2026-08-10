const Invoice = require("../db_models/invoice.model");
const Guest = require("../db_models/guest.model");
const {
  changesFromPayload,
  writeAuditLog
} = require("./booking-audit.service");
const {
  buildAccommodationLines,
  nextDocumentNumber
} = require("./financial-document.service");

const SYSTEM_ACTOR = Object.freeze({
  user_id: "system",
  name: "System",
  email: ""
});

const AUTOMATIC_INVOICE_SYNC_FIELDS = [
  "billing_snapshot",
  "stay_snapshot",
  "currency",
  "line_items",
  "subtotal",
  "discount_total",
  "tax_total",
  "grand_total"
];

const INVOICE_STATUSES_REQUIRING_CORRECTION = new Set([
  "issued",
  "partially_paid",
  "paid"
]);

/**
 * Creates the initial draft invoice for a confirmed reservation.
 *
 * The lookup makes this operation idempotent: editing or retrying a confirmed
 * reservation will return its existing invoice instead of creating a duplicate.
 */
async function ensureInvoiceForConfirmedReservation({
  reservation,
  requestId = "",
  session
}) {
  if (reservation.status !== "confirmed") {
    return { created: false, invoice: null };
  }

  const existingInvoice = await Invoice.findOne({
    property_id: reservation.property_id,
    reservation_id: reservation._id
  })
    .sort({ invoice_date: 1, _id: 1 })
    .session(session);

  if (existingInvoice) {
    return { created: false, invoice: existingInvoice };
  }

  const guest = await findReservationGuest(reservation, session);

  const invoiceDate = new Date();
  const invoiceNo = await nextDocumentNumber({
    propertyId: reservation.property_id,
    documentType: "invoice",
    date: invoiceDate,
    session
  });

  const [invoice] = await Invoice.create([{
    property_id: reservation.property_id,
    invoice_no: invoiceNo,
    reference_number: automaticInvoiceReference(reservation),
    reservation_id: reservation._id,
    reservation_no: reservation.reservation_no,
    guest_id: guest._id,
    billing_type: "guest",
    billing_snapshot: {
      name: guest.name,
      email: guest.email,
      phone: guest.phone,
      country: guest.country
    },
    stay_snapshot: {
      check_in: reservation.check_in,
      check_out: reservation.check_out,
      nights: reservation.is_day_room ? 0 : reservation.nights,
      is_day_room: reservation.is_day_room,
      room_numbers: reservation.rooms
        .map((room) => room.room_number)
        .filter(Boolean)
    },
    invoice_date: invoiceDate,
    due_date: invoiceDate,
    currency: reservation.currency,
    line_items: buildAccommodationLines(reservation),
    status: "draft",
    notes: `Automatically created when reservation ${reservation.reservation_no} was confirmed.`,
    created_by: SYSTEM_ACTOR,
    updated_by: SYSTEM_ACTOR
  }], { session });

  await writeAuditLog({
    propertyId: reservation.property_id,
    entityType: "invoice",
    entityId: invoice._id,
    action: "invoice_created_automatically",
    description:
      `Draft invoice ${invoice.invoice_no} was automatically created for ` +
      `reservation ${reservation.reservation_no}.`,
    actor: SYSTEM_ACTOR,
    requestId,
    session
  });
  await writeAuditLog({
    propertyId: reservation.property_id,
    entityType: "reservation",
    entityId: reservation._id,
    action: "reservation_invoice_created",
    description:
      `System created draft invoice ${invoice.invoice_no} for reservation ` +
      `${reservation.reservation_no}.`,
    actor: SYSTEM_ACTOR,
    requestId,
    session
  });

  return { created: true, invoice };
}

/**
 * Keeps the system-created draft invoice aligned with an edited reservation.
 * Issued invoices and manually created drafts are intentionally left unchanged.
 */
async function synchronizeAutomaticDraftInvoice({
  reservation,
  requestId = "",
  session
}) {
  if (reservation.status !== "confirmed") {
    return { updated: false, invoice: null };
  }

  const invoice = await Invoice.findOne({
    property_id: reservation.property_id,
    reservation_id: reservation._id,
    reference_number: automaticInvoiceReference(reservation)
  }).session(session);

  if (!invoice || invoice.status !== "draft") {
    return { updated: false, invoice };
  }

  const guest = await findReservationGuest(reservation, session);
  const before = invoice.toObject({ virtuals: true });
  const nonAccommodationLines = invoice.line_items
    .filter((line) => line.source_type !== "accommodation")
    .map((line) => line.toObject({ virtuals: false }));

  if (invoice.billing_type === "guest") {
    invoice.guest_id = guest._id;
    invoice.billing_snapshot = {
      name: guest.name,
      email: guest.email,
      phone: guest.phone,
      address: invoice.billing_snapshot?.address || "",
      country: guest.country,
      tax_number: invoice.billing_snapshot?.tax_number || ""
    };
  }
  invoice.stay_snapshot = {
    check_in: reservation.check_in,
    check_out: reservation.check_out,
    nights: reservation.is_day_room ? 0 : reservation.nights,
    is_day_room: reservation.is_day_room,
    room_numbers: reservation.rooms
      .map((room) => room.room_number)
      .filter(Boolean)
  };
  invoice.currency = reservation.currency;
  invoice.line_items = [
    ...buildAccommodationLines(reservation),
    ...nonAccommodationLines
  ];
  invoice.updated_by = SYSTEM_ACTOR;
  await invoice.save({ session });

  const changes = changesFromPayload(
    before,
    invoice.toObject({ virtuals: true }),
    AUTOMATIC_INVOICE_SYNC_FIELDS
  );
  if (!changes.length) {
    return { updated: false, invoice };
  }

  await writeAuditLog({
    propertyId: reservation.property_id,
    entityType: "invoice",
    entityId: invoice._id,
    action: "invoice_synchronized_automatically",
    description:
      `System updated draft invoice ${invoice.invoice_no} after reservation ` +
      `${reservation.reservation_no} changed.`,
    actor: SYSTEM_ACTOR,
    changes,
    requestId,
    session
  });
  await writeAuditLog({
    propertyId: reservation.property_id,
    entityType: "reservation",
    entityId: reservation._id,
    action: "reservation_invoice_synchronized",
    description:
      `System synchronized draft invoice ${invoice.invoice_no} with reservation ` +
      `${reservation.reservation_no}.`,
    actor: SYSTEM_ACTOR,
    requestId,
    session
  });

  return { updated: true, invoice };
}

/**
 * Voids draft invoices before cancellation. Financially active invoices must
 * be corrected with credit notes/refunds before the reservation can cancel.
 */
async function prepareInvoicesForReservationCancellation({
  reservation,
  cancellationReason,
  requestId = "",
  session
}) {
  const invoices = await Invoice.find({
    property_id: reservation.property_id,
    reservation_id: reservation._id
  })
    .sort({ invoice_date: 1, _id: 1 })
    .session(session);

  const invoicesRequiringCorrection = invoices.filter((invoice) =>
    INVOICE_STATUSES_REQUIRING_CORRECTION.has(invoice.status) ||
    Number(invoice.refund_due || 0) > 0
  );
  if (invoicesRequiringCorrection.length) {
    const details = invoicesRequiringCorrection
      .map((invoice) => {
        const refundDue = Number(invoice.refund_due || 0);
        return refundDue > 0
          ? `${invoice.invoice_no} (${invoice.status}, refund due ${invoice.currency} ${refundDue.toFixed(2)})`
          : `${invoice.invoice_no} (${invoice.status})`;
      })
      .join(", ");
    throw conflict(
      `Reservation ${reservation.reservation_no} cannot be cancelled while ` +
      `${details} is financially active. Issue the required credit note and ` +
      "complete any refund first, then try the cancellation again."
    );
  }

  const draftInvoices = invoices.filter((invoice) => invoice.status === "draft");
  for (const invoice of draftInvoices) {
    invoice.status = "voided";
    invoice.void_reason =
      `Reservation ${reservation.reservation_no} cancelled: ${cancellationReason}`;
    invoice.voided_by = SYSTEM_ACTOR;
    invoice.voided_at = new Date();
    invoice.updated_by = SYSTEM_ACTOR;
    await invoice.save({ session });

    await writeAuditLog({
      propertyId: reservation.property_id,
      entityType: "invoice",
      entityId: invoice._id,
      action: "invoice_voided_automatically",
      description:
        `System voided draft invoice ${invoice.invoice_no} because reservation ` +
        `${reservation.reservation_no} was cancelled.`,
      actor: SYSTEM_ACTOR,
      changes: [{ field: "status", from: "draft", to: "voided" }],
      requestId,
      session
    });
    await writeAuditLog({
      propertyId: reservation.property_id,
      entityType: "reservation",
      entityId: reservation._id,
      action: "reservation_invoice_voided",
      description:
        `System voided draft invoice ${invoice.invoice_no} during reservation ` +
        `${reservation.reservation_no} cancellation.`,
      actor: SYSTEM_ACTOR,
      requestId,
      session
    });
  }

  return { voidedInvoices: draftInvoices };
}

async function findReservationGuest(reservation, session) {
  const guestProfileId = reservation.booker?.guest_profile_id;
  if (!guestProfileId) {
    throw conflict(
      "The reservation must have a saved guest profile before its invoice can be processed."
    );
  }

  const guest = await Guest.findOne({
    _id: guestProfileId,
    property_id: reservation.property_id
  }).session(session);
  if (!guest) {
    throw conflict(
      "The reservation guest profile was not found, so its invoice could not be processed."
    );
  }
  return guest;
}

function automaticInvoiceReference(reservation) {
  return `AUTO-${reservation.reservation_no}`;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

module.exports = {
  SYSTEM_ACTOR,
  ensureInvoiceForConfirmedReservation,
  prepareInvoicesForReservationCancellation,
  synchronizeAutomaticDraftInvoice
};
