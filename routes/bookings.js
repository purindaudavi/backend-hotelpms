const crypto = require("node:crypto");
const express = require("express");
const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const ReservationAttachment = require("../db_models/reservation-attachment.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const Guest = require("../db_models/guest.model");
const RoomType = require("../db_models/rooms.model");
const {
  actorFromRequest,
  changesFromPayload,
  writeAuditLog
} = require("../services/booking-audit.service");
const {
  getBusinessBlockMetrics,
  occupyAssignedRooms,
  releaseAssignedRoomsAfterCheckout,
  validateBusinessBlockInventory,
  validateReservationInventory
} = require("../services/booking-availability.service");
const {
  ensureInvoiceForConfirmedReservation,
  prepareInvoicesForReservationCancellation,
  synchronizeAutomaticDraftInvoice
} = require("../services/invoice-automation.service");

const router = express.Router();
const attachmentBodyParser = express.raw({ type: "*/*", limit: "10mb" });

const RESERVATION_EDIT_FIELDS = [
  "booking_reference",
  "reservation_date",
  "check_in",
  "check_out",
  "is_day_room",
  "booking_source",
  "tour_number",
  "group_name",
  "travel_agent",
  "booker",
  "rooms",
  "occupants",
  "currency",
  "rate_plan_id",
  "rate_plan_name",
  "meal_plan",
  "refundable",
  "cancellation_policy",
  "financial_summary",
  "reservation_remarks",
  "guest_remarks",
  "internal_remarks"
];

const BLOCK_EDIT_FIELDS = [
  "block_name",
  "company_name",
  "contact",
  "check_in",
  "check_out",
  "cutoff_date",
  "allocations",
  "billing",
  "cancellation_policy",
  "block_remarks",
  "internal_remarks",
  "special_requirements"
];

// Reservations

router.get("/reservations", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = {
    property_id: propertyId,
    deleted_at: { $exists: false }
  };

  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { reservation_no: pattern },
      { booking_reference: pattern },
      { booking_source: pattern },
      { "booker.name": pattern },
      { "booker.phone": pattern },
      { "booker.email": pattern },
      { "travel_agent.name": pattern }
    ];
  }

  const status = normalizeEnum(req.query.status);
  if (status && status !== "all") query.status = status;
  if (req.query.booking_source && req.query.booking_source !== "all") {
    query.booking_source = new RegExp(
      `^${escapeRegExp(String(req.query.booking_source))}$`,
      "i"
    );
  }
  if (req.query.travel_agent_id) {
    query["travel_agent.travel_agent_id"] = String(req.query.travel_agent_id);
  }

  applyDateFilter(query, req.query);
  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const skip = (page - 1) * limit;
  const sort = reservationSort(req.query.sort);

  const [reservations, total] = await Promise.all([
    Reservation.find(query).sort(sort).skip(skip).limit(limit),
    Reservation.countDocuments(query)
  ]);

  return res.status(200).json({
    count: reservations.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    reservations: reservations.map(
      req.query.details === "true"
        ? serializeReservation
        : serializeReservationSummary
    )
  });
}));

router.post("/reservations", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const result = await inTransaction(async (session) => {
    const reservation = new Reservation({
      property_id: propertyId,
      reservation_no: generateReference("RES"),
      created_by: actor,
      updated_by: actor
    });
    applyFields(reservation, req.body || {}, RESERVATION_EDIT_FIELDS);

    const initialStatus = normalizeEnum(req.body?.status);
    if (initialStatus) {
      if (!["tentative", "confirmed", "blocked"].includes(initialStatus)) {
        throw badRequest(
          "A new reservation can start only as tentative, confirmed, or blocked."
        );
      }
      reservation.status = initialStatus;
    }

    await reservation.validate();
    await validateReservationInventory({
      propertyId,
      checkIn: reservation.check_in,
      checkOut: reservation.check_out,
      rooms: reservation.rooms,
      linkedBusinessBlockId: reservation.business_block_id,
      session
    });
    await synchronizeGuestProfile(reservation, session);
    await reservation.save({ session });
    await writeAuditLog({
      propertyId,
      entityType: "reservation",
      entityId: reservation._id,
      action: "reservation_created",
      description: `Reservation ${reservation.reservation_no} was created.`,
      actor,
      requestId: requestId(req),
      session
    });
    await ensureInvoiceForConfirmedReservation({
      reservation,
      requestId: requestId(req),
      session
    });
    return reservation;
  });

  return res.status(201).json({
    message: "Reservation created successfully.",
    reservation: serializeReservation(result)
  });
}));

router.get("/reservations/:reservationId", asyncHandler(async (req, res) => {
  const reservation = await findReservation(req);
  if (!reservation) {
    return res.status(404).json({ message: "Reservation not found." });
  }

  const [logs, attachments, payments] = await Promise.all([
    BookingAuditLog.find({
      property_id: reservation.property_id,
      entity_type: "reservation",
      entity_id: reservation._id
    }).sort({ created_at: -1 }),
    ReservationAttachment.find({
      property_id: reservation.property_id,
      reservation_id: reservation._id,
      deleted_at: { $exists: false }
    }).sort({ uploaded_at: -1 }),
    ReservationPayment.find({
      property_id: reservation.property_id,
      reservation_id: reservation._id
    }).sort({ posted_at: -1 })
  ]);

  return res.status(200).json({
    reservation: serializeReservation(reservation),
    logs,
    attachments: attachments.map((attachment) =>
      serializeAttachment(attachment, req)
    ),
    payments
  });
}));

router.patch("/reservations/:reservationId", asyncHandler(async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "status")) {
    throw badRequest("Use a reservation lifecycle endpoint to change status.");
  }

  const actor = actorFromRequest(req);
  const reservation = await inTransaction(async (session) => {
    const record = await findReservation(req, session);
    if (!record) throw notFound("Reservation not found.");
    if (["checked_out", "cancelled", "no_show"].includes(record.status)) {
      throw conflict("A terminal reservation cannot be edited.");
    }

    const before = record.toObject({ virtuals: false });
    applyFields(record, req.body || {}, RESERVATION_EDIT_FIELDS);
    record.updated_by = actor;
    await record.validate();
    await validateReservationInventory({
      propertyId: record.property_id,
      checkIn: record.check_in,
      checkOut: record.check_out,
      rooms: record.rooms,
      excludeReservationId: record._id,
      linkedBusinessBlockId: record.business_block_id,
      session
    });
    await synchronizeGuestProfile(record, session);
    await record.save({ session });

    const after = record.toObject({ virtuals: false });
    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "reservation",
      entityId: record._id,
      action: "reservation_updated",
      description: `Reservation ${record.reservation_no} was updated.`,
      actor,
      changes: changesFromPayload(before, after, RESERVATION_EDIT_FIELDS),
      requestId: requestId(req),
      session
    });
    await synchronizeAutomaticDraftInvoice({
      reservation: record,
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(200).json({
    message: "Reservation updated successfully.",
    reservation: serializeReservation(reservation)
  });
}));

router.delete("/reservations/:reservationId", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  await inTransaction(async (session) => {
    const reservation = await findReservation(req, session);
    if (!reservation) throw notFound("Reservation not found.");
    if (reservation.status === "checked_in") {
      throw conflict("Check out the guest before deleting this reservation.");
    }
    reservation.deleted_at = new Date();
    reservation.deleted_by = actor;
    reservation.updated_by = actor;
    await reservation.save({ session });
    await writeAuditLog({
      propertyId: reservation.property_id,
      entityType: "reservation",
      entityId: reservation._id,
      action: "reservation_deleted",
      description: `Reservation ${reservation.reservation_no} was archived.`,
      actor,
      requestId: requestId(req),
      session
    });
  });

  return res.status(200).json({ message: "Reservation archived successfully." });
}));

router.post("/reservations/:reservationId/confirm", asyncHandler(async (req, res) => {
  const reservation = await transitionReservation(req, {
    from: ["tentative"],
    to: "confirmed",
    action: "reservation_confirmed",
    description: (record) => `Reservation ${record.reservation_no} was confirmed.`
  });
  return res.status(200).json({
    message: "Reservation confirmed successfully.",
    reservation: serializeReservation(reservation)
  });
}));

router.post("/reservations/:reservationId/check-in", asyncHandler(async (req, res) => {
  const businessDate = dateOnly(req.body?.business_date || new Date());
  const actor = actorFromRequest(req);
  const reservation = await inTransaction(async (session) => {
    const record = await findReservation(req, session);
    if (!record) throw notFound("Reservation not found.");
    if (record.status !== "confirmed") {
      throw conflict("Only a confirmed reservation can be checked in.");
    }
    const checkIn = dateOnly(record.check_in);
    const checkOut = dateOnly(record.check_out);
    if (businessDate < checkIn || (!record.is_day_room && businessDate >= checkOut)) {
      throw conflict("The business date is outside this reservation's stay dates.");
    }

    await occupyAssignedRooms(record, { session });
    record.status = "checked_in";
    record.checked_in_at = new Date();
    record.checked_in_by = actor;
    record.updated_by = actor;
    await record.save({ session });
    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "reservation",
      entityId: record._id,
      action: "reservation_checked_in",
      description: `Reservation ${record.reservation_no} was checked in.`,
      actor,
      changes: [{ field: "status", from: "confirmed", to: "checked_in" }],
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(200).json({
    message: "Reservation checked in successfully.",
    reservation: serializeReservation(reservation)
  });
}));

router.post("/reservations/:reservationId/check-out", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const reservation = await inTransaction(async (session) => {
    const record = await findReservation(req, session);
    if (!record) throw notFound("Reservation not found.");
    if (record.status !== "checked_in") {
      throw conflict("Only a checked-in reservation can be checked out.");
    }
    await releaseAssignedRoomsAfterCheckout(record, { session });
    record.status = "checked_out";
    record.checked_out_at = new Date();
    record.checked_out_by = actor;
    record.updated_by = actor;
    await record.save({ session });
    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "reservation",
      entityId: record._id,
      action: "reservation_checked_out",
      description: `Reservation ${record.reservation_no} was checked out.`,
      actor,
      changes: [{ field: "status", from: "checked_in", to: "checked_out" }],
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(200).json({
    message: "Reservation checked out successfully. Assigned rooms are now dirty.",
    reservation: serializeReservation(reservation)
  });
}));

router.post("/reservations/:reservationId/cancel", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw badRequest("Cancellation reason is required.");
  const reservation = await transitionReservation(req, {
    from: ["tentative", "confirmed", "blocked"],
    to: "cancelled",
    action: "reservation_cancelled",
    description: (record) =>
      `Reservation ${record.reservation_no} was cancelled: ${reason}`,
    beforeTransition({ reservation: record, requestId: currentRequestId, session }) {
      return prepareInvoicesForReservationCancellation({
        reservation: record,
        cancellationReason: reason,
        requestId: currentRequestId,
        session
      });
    },
    mutate(record, actor) {
      record.cancelled_at = new Date();
      record.cancelled_by = actor;
      record.cancellation_reason = reason;
    }
  });
  return res.status(200).json({
    message: "Reservation cancelled successfully.",
    reservation: serializeReservation(reservation)
  });
}));

router.post("/reservations/:reservationId/no-show", asyncHandler(async (req, res) => {
  const reservation = await transitionReservation(req, {
    from: ["confirmed"],
    to: "no_show",
    action: "reservation_no_show",
    description: (record) =>
      `Reservation ${record.reservation_no} was marked as no-show.`,
    mutate(record, actor) {
      record.no_show_at = new Date();
      record.no_show_by = actor;
    }
  });
  return res.status(200).json({
    message: "Reservation marked as no-show.",
    reservation: serializeReservation(reservation)
  });
}));

// Reservation rooming list

router.post("/reservations/:reservationId/occupants", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const reservation = await inTransaction(async (session) => {
    const record = await findReservation(req, session);
    if (!record) throw notFound("Reservation not found.");
    record.occupants.push(req.body || {});
    record.updated_by = actor;
    await record.save({ session });
    const occupant = record.occupants[record.occupants.length - 1];
    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "reservation",
      entityId: record._id,
      action: "occupant_added",
      description: `${occupant.name} was added to the rooming list.`,
      actor,
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(201).json({
    message: "Occupant added successfully.",
    reservation: serializeReservation(reservation)
  });
}));

router.patch("/reservations/:reservationId/occupants/:occupantId", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const reservation = await inTransaction(async (session) => {
    const record = await findReservation(req, session);
    if (!record) throw notFound("Reservation not found.");
    const occupant = record.occupants.id(req.params.occupantId);
    if (!occupant) throw notFound("Occupant not found.");
    applyFields(occupant, req.body || {}, [
      "room_line_id",
      "guest_profile_id",
      "title",
      "name",
      "guest_type",
      "is_primary",
      "is_main_booker",
      "email",
      "phone",
      "country"
    ]);
    record.updated_by = actor;
    await record.save({ session });
    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "reservation",
      entityId: record._id,
      action: "occupant_updated",
      description: `${occupant.name} was updated in the rooming list.`,
      actor,
      requestId: requestId(req),
      session
    });
    return record;
  });
  return res.status(200).json({
    message: "Occupant updated successfully.",
    reservation: serializeReservation(reservation)
  });
}));

router.delete("/reservations/:reservationId/occupants/:occupantId", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const reservation = await inTransaction(async (session) => {
    const record = await findReservation(req, session);
    if (!record) throw notFound("Reservation not found.");
    const occupant = record.occupants.id(req.params.occupantId);
    if (!occupant) throw notFound("Occupant not found.");
    const name = occupant.name;
    occupant.deleteOne();
    record.updated_by = actor;
    await record.save({ session });
    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "reservation",
      entityId: record._id,
      action: "occupant_removed",
      description: `${name} was removed from the rooming list.`,
      actor,
      requestId: requestId(req),
      session
    });
    return record;
  });
  return res.status(200).json({
    message: "Occupant removed successfully.",
    reservation: serializeReservation(reservation)
  });
}));

// Reservation payments

router.get("/reservations/:reservationId/payments", asyncHandler(async (req, res) => {
  const reservation = await findReservation(req);
  if (!reservation) throw notFound("Reservation not found.");
  const payments = await ReservationPayment.find({
    property_id: reservation.property_id,
    reservation_id: reservation._id
  }).sort({ posted_at: -1 });
  return res.status(200).json({ count: payments.length, payments });
}));

router.post("/reservations/:reservationId/payments", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const payment = await inTransaction(async (session) => {
    const reservation = await findReservation(req, session);
    if (!reservation) throw notFound("Reservation not found.");
    const status = normalizeEnum(req.body?.status) || "posted";
    if (!["posted", "refunded"].includes(status)) {
      throw badRequest("A new payment status must be posted or refunded.");
    }
    const [record] = await ReservationPayment.create([{
      property_id: reservation.property_id,
      reservation_id: reservation._id,
      amount: req.body?.amount,
      currency: req.body?.currency || reservation.currency,
      payment_method: req.body?.payment_method,
      payment_reference: req.body?.payment_reference,
      status,
      notes: req.body?.notes,
      posted_by: actor
    }], { session });

    await refreshPaidTotal(reservation, session);
    await writeAuditLog({
      propertyId: reservation.property_id,
      entityType: "reservation",
      entityId: reservation._id,
      action: status === "refunded" ? "payment_refunded" : "payment_posted",
      description: `${record.currency} ${record.amount} was ${status}.`,
      actor,
      requestId: requestId(req),
      session
    });
    return record;
  });
  return res.status(201).json({
    message: "Payment recorded successfully.",
    payment
  });
}));

router.post("/reservations/:reservationId/payments/:paymentId/void", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw badRequest("Void reason is required.");
  const actor = actorFromRequest(req);
  const payment = await inTransaction(async (session) => {
    const reservation = await findReservation(req, session);
    if (!reservation) throw notFound("Reservation not found.");
    const record = await ReservationPayment.findOne({
      _id: req.params.paymentId,
      property_id: reservation.property_id,
      reservation_id: reservation._id
    }).session(session);
    if (!record) throw notFound("Payment not found.");
    if (record.status === "voided") throw conflict("This payment is already voided.");
    record.status = "voided";
    record.voided_at = new Date();
    record.voided_by = actor;
    record.void_reason = reason;
    await record.save({ session });
    await refreshPaidTotal(reservation, session);
    await writeAuditLog({
      propertyId: reservation.property_id,
      entityType: "reservation",
      entityId: reservation._id,
      action: "payment_voided",
      description: `Payment ${record._id} was voided: ${reason}`,
      actor,
      requestId: requestId(req),
      session
    });
    return record;
  });
  return res.status(200).json({
    message: "Payment voided successfully.",
    payment
  });
}));

// Reservation attachments

router.get("/reservations/:reservationId/attachments", asyncHandler(async (req, res) => {
  const reservation = await findReservation(req);
  if (!reservation) throw notFound("Reservation not found.");
  const attachments = await ReservationAttachment.find({
    property_id: reservation.property_id,
    reservation_id: reservation._id,
    deleted_at: { $exists: false }
  }).sort({ uploaded_at: -1 });
  return res.status(200).json({
    count: attachments.length,
    attachments: attachments.map((attachment) =>
      serializeAttachment(attachment, req)
    )
  });
}));

router.post(
  "/reservations/:reservationId/attachments",
  attachmentBodyParser,
  asyncHandler(async (req, res) => {
    const reservation = await findReservation(req);
    if (!reservation) throw notFound("Reservation not found.");
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw unsupportedMedia(
        "Send the attachment file as the raw request body."
      );
    }

    const actor = actorFromRequest(req);
    const fileName = safeFilename(req.get("x-file-name") || `attachment-${Date.now()}`);
    const contentType = String(req.get("content-type") || "application/octet-stream");
    const category = normalizeEnum(req.get("x-document-category") || "other");
    const bucket = getAttachmentBucket();
    const uploaded = await uploadGridFsFile(bucket, req.body, {
      filename: fileName,
      contentType,
      metadata: {
        property_id: reservation.property_id,
        reservation_id: reservation._id
      }
    });

    let attachment;
    try {
      [attachment] = await ReservationAttachment.create([{
        property_id: reservation.property_id,
        reservation_id: reservation._id,
        file_id: uploaded.id,
        file_name: fileName,
        content_type: contentType,
        file_size: req.body.length,
        document_category: category,
        description: req.get("x-description") || "",
        uploaded_by: actor
      }]);
      await writeAuditLog({
        propertyId: reservation.property_id,
        entityType: "reservation",
        entityId: reservation._id,
        action: "attachment_added",
        description: `${fileName} was attached to the reservation.`,
        actor,
        requestId: requestId(req)
      });
    } catch (error) {
      await deleteGridFsFile(bucket, uploaded.id);
      throw error;
    }

    return res.status(201).json({
      message: "Attachment uploaded successfully.",
      attachment: serializeAttachment(attachment, req)
    });
  })
);

router.get("/reservations/:reservationId/attachments/:attachmentId/file", asyncHandler(async (req, res) => {
  const reservation = await findReservation(req);
  if (!reservation) throw notFound("Reservation not found.");
  const attachment = await findAttachment(reservation, req.params.attachmentId);
  if (!attachment) throw notFound("Attachment not found.");

  res.set({
    "Content-Type": attachment.content_type,
    "Content-Length": attachment.file_size,
    "Content-Disposition": `inline; filename="${safeFilename(attachment.file_name)}"`,
    "Cache-Control": "private, max-age=3600"
  });
  const stream = getAttachmentBucket().openDownloadStream(attachment.file_id);
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(error.code === "ENOENT" ? 404 : 500).json({
        message:
          error.code === "ENOENT"
            ? "Stored attachment file not found."
            : "Attachment could not be read."
      });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}));

router.delete("/reservations/:reservationId/attachments/:attachmentId", asyncHandler(async (req, res) => {
  const reservation = await findReservation(req);
  if (!reservation) throw notFound("Reservation not found.");
  const attachment = await findAttachment(reservation, req.params.attachmentId);
  if (!attachment) throw notFound("Attachment not found.");
  const actor = actorFromRequest(req);
  attachment.deleted_at = new Date();
  await attachment.save();
  await deleteGridFsFile(getAttachmentBucket(), attachment.file_id);
  await writeAuditLog({
    propertyId: reservation.property_id,
    entityType: "reservation",
    entityId: reservation._id,
    action: "attachment_removed",
    description: `${attachment.file_name} was removed from the reservation.`,
    actor,
    requestId: requestId(req)
  });
  return res.status(200).json({ message: "Attachment deleted successfully." });
}));

router.get("/reservations/:reservationId/logs", asyncHandler(async (req, res) => {
  const reservation = await findReservation(req);
  if (!reservation) throw notFound("Reservation not found.");
  const logs = await BookingAuditLog.find({
    property_id: reservation.property_id,
    entity_type: "reservation",
    entity_id: reservation._id
  }).sort({ created_at: -1 });
  return res.status(200).json({ count: logs.length, logs });
}));

// Business blocks

router.get("/business-blocks", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const query = {
    property_id: propertyId,
    deleted_at: { $exists: false }
  };
  const status = normalizeEnum(req.query.status);
  if (status && status !== "all") query.status = status;
  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { block_number: pattern },
      { block_name: pattern },
      { company_name: pattern },
      { "contact.name": pattern },
      { "contact.email": pattern }
    ];
  }
  if (req.query.date_from || req.query.date_to) {
    if (req.query.date_from) query.check_out = { $gt: parseDate(req.query.date_from) };
    if (req.query.date_to) query.check_in = { $lt: endOfDate(req.query.date_to) };
  }

  const blocks = await BusinessBlock.find(query).sort({ check_in: -1, block_number: 1 });
  const serialized = await Promise.all(
    blocks.map(async (block) =>
      serializeBusinessBlock(block, await getBusinessBlockMetrics(block))
    )
  );
  return res.status(200).json({
    count: serialized.length,
    business_blocks: serialized
  });
}));

router.post("/business-blocks", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const block = await inTransaction(async (session) => {
    const record = new BusinessBlock({
      property_id: propertyId,
      block_number: generateReference("BB"),
      status: "tentative",
      created_by: actor,
      updated_by: actor
    });
    applyFields(record, req.body || {}, BLOCK_EDIT_FIELDS);
    await enrichAndValidateAllocations(record, session);
    await record.save({ session });
    await writeAuditLog({
      propertyId,
      entityType: "business_block",
      entityId: record._id,
      action: "business_block_created",
      description: `Business block ${record.block_number} was created.`,
      actor,
      requestId: requestId(req),
      session
    });
    return record;
  });
  return res.status(201).json({
    message: "Business block created successfully.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.get("/business-blocks/:blockId", asyncHandler(async (req, res) => {
  const block = await findBusinessBlock(req);
  if (!block) throw notFound("Business block not found.");
  const [metrics, logs, linkedReservations] = await Promise.all([
    getBusinessBlockMetrics(block),
    BookingAuditLog.find({
      property_id: block.property_id,
      entity_type: "business_block",
      entity_id: block._id
    }).sort({ created_at: -1 }),
    Reservation.find({
      property_id: block.property_id,
      business_block_id: block._id,
      deleted_at: { $exists: false }
    }).sort({ reservation_date: -1 })
  ]);
  return res.status(200).json({
    business_block: serializeBusinessBlock(block, metrics),
    rooming_list: linkedReservations.map(serializeReservationSummary),
    logs
  });
}));

router.patch("/business-blocks/:blockId", asyncHandler(async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "status")) {
    throw badRequest("Use a business-block lifecycle endpoint to change status.");
  }
  const actor = actorFromRequest(req);
  const block = await inTransaction(async (session) => {
    const record = await findBusinessBlock(req, session);
    if (!record) throw notFound("Business block not found.");
    if (["released", "cancelled", "completed"].includes(record.status)) {
      throw conflict("A terminal business block cannot be edited.");
    }
    const before = record.toObject({ virtuals: false });
    applyFields(record, req.body || {}, BLOCK_EDIT_FIELDS);
    record.updated_by = actor;
    await enrichAndValidateAllocations(record, session);
    if (record.status === "active") {
      await validateBusinessBlockInventory({
        block: record,
        excludeBlockId: record._id,
        session
      });
    }
    await record.save({ session });
    const after = record.toObject({ virtuals: false });
    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "business_block",
      entityId: record._id,
      action: "business_block_updated",
      description: `Business block ${record.block_number} was updated.`,
      actor,
      changes: changesFromPayload(before, after, BLOCK_EDIT_FIELDS),
      requestId: requestId(req),
      session
    });
    return record;
  });
  return res.status(200).json({
    message: "Business block updated successfully.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.delete("/business-blocks/:blockId", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  await inTransaction(async (session) => {
    const block = await findBusinessBlock(req, session);
    if (!block) throw notFound("Business block not found.");
    if (block.status === "active") {
      throw conflict("Release or cancel an active business block before archiving it.");
    }
    block.deleted_at = new Date();
    block.deleted_by = actor;
    block.updated_by = actor;
    await block.save({ session });
    await writeAuditLog({
      propertyId: block.property_id,
      entityType: "business_block",
      entityId: block._id,
      action: "business_block_deleted",
      description: `Business block ${block.block_number} was archived.`,
      actor,
      requestId: requestId(req),
      session
    });
  });
  return res.status(200).json({ message: "Business block archived successfully." });
}));

router.post("/business-blocks/:blockId/activate", asyncHandler(async (req, res) => {
  const block = await transitionBusinessBlock(req, {
    from: ["tentative"],
    to: "active",
    action: "business_block_activated",
    validate: validateBusinessBlockInventory
  });
  return res.status(200).json({
    message: "Business block activated successfully.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.post("/business-blocks/:blockId/release", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const block = await inTransaction(async (session) => {
    const record = await findBusinessBlock(req, session);
    if (!record) throw notFound("Business block not found.");
    if (record.status !== "active") {
      throw conflict("Only an active business block can be released.");
    }
    const metrics = await getBusinessBlockMetrics(record, { session });
    for (const allocation of record.allocations) {
      const allocationMetrics = metrics.allocations.find(
        (item) => String(item.allocation_id) === String(allocation._id)
      );
      allocation.released_quantity += allocationMetrics?.remaining || 0;
    }
    record.status = "released";
    record.updated_by = actor;
    await record.save({ session });
    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "business_block",
      entityId: record._id,
      action: "business_block_released",
      description: `Remaining inventory for ${record.block_number} was released.`,
      actor,
      changes: [{ field: "status", from: "active", to: "released" }],
      requestId: requestId(req),
      session
    });
    return record;
  });
  return res.status(200).json({
    message: "Remaining business-block inventory released successfully.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.post("/business-blocks/:blockId/cancel", asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw badRequest("Cancellation reason is required.");
  const block = await transitionBusinessBlock(req, {
    from: ["tentative", "active"],
    to: "cancelled",
    action: "business_block_cancelled",
    description: (record) =>
      `Business block ${record.block_number} was cancelled: ${reason}`
  });
  return res.status(200).json({
    message: "Business block cancelled successfully. Existing reservations were retained.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.post("/business-blocks/:blockId/complete", asyncHandler(async (req, res) => {
  const block = await transitionBusinessBlock(req, {
    from: ["active"],
    to: "completed",
    action: "business_block_completed"
  });
  return res.status(200).json({
    message: "Business block completed successfully.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.post("/business-blocks/:blockId/allocations", asyncHandler(async (req, res) => {
  const block = await mutateAllocation(req, "add");
  return res.status(201).json({
    message: "Allocation added successfully.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.patch("/business-blocks/:blockId/allocations/:allocationId", asyncHandler(async (req, res) => {
  const block = await mutateAllocation(req, "update");
  return res.status(200).json({
    message: "Allocation updated successfully.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.delete("/business-blocks/:blockId/allocations/:allocationId", asyncHandler(async (req, res) => {
  const block = await mutateAllocation(req, "delete");
  return res.status(200).json({
    message: "Allocation removed successfully.",
    business_block: serializeBusinessBlock(
      block,
      await getBusinessBlockMetrics(block)
    )
  });
}));

router.post("/business-blocks/:blockId/allocations/:allocationId/reservations", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const reservation = await inTransaction(async (session) => {
    const block = await findBusinessBlock(req, session);
    if (!block) throw notFound("Business block not found.");
    if (block.status !== "active") {
      throw conflict("Reservations can be picked up only from an active block.");
    }
    const allocation = block.allocations.id(req.params.allocationId);
    if (!allocation) throw notFound("Business-block allocation not found.");
    const metrics = await getBusinessBlockMetrics(block, { session });
    const allocationMetrics = metrics.allocations.find(
      (item) => String(item.allocation_id) === String(allocation._id)
    );
    const quantity = positiveInteger(req.body?.quantity, 1);
    if (quantity > (allocationMetrics?.remaining || 0)) {
      throw conflict(
        `This allocation has only ${allocationMetrics?.remaining || 0} room(s) remaining.`
      );
    }

    const rooms = Array.isArray(req.body?.rooms) && req.body.rooms.length
      ? req.body.rooms
      : Array.from({ length: quantity }, () => ({
          room_type_id: allocation.room_type_id,
          room_type_name: allocation.room_type_name,
          adults: 1,
          children: 0,
          rate_plan_id: allocation.rate_plan_id,
          rate_plan_name: allocation.rate_plan_name,
          meal_plan: allocation.meal_plan,
          currency: allocation.currency,
          original_nightly_rate: allocation.negotiated_rate,
          effective_nightly_rate: allocation.negotiated_rate,
          is_complimentary: allocation.is_complimentary,
          complimentary_reason: allocation.complimentary_reason,
          business_block_allocation_id: allocation._id
        }));
    if (rooms.length !== quantity) {
      throw badRequest("quantity must match the number of supplied reservation rooms.");
    }
    rooms.forEach((room) => {
      room.room_type_id = allocation.room_type_id;
      room.room_type_name = allocation.room_type_name;
      room.business_block_allocation_id = allocation._id;
    });

    const record = new Reservation({
      property_id: propertyId,
      reservation_no: generateReference("RES"),
      booking_source: req.body?.booking_source || "Company",
      booking_reference: req.body?.booking_reference || block.block_number,
      reservation_date: req.body?.reservation_date || new Date(),
      check_in: block.check_in,
      check_out: block.check_out,
      status: "confirmed",
      tour_number: req.body?.tour_number || "",
      group_name: req.body?.group_name || block.block_name,
      travel_agent: req.body?.travel_agent || {},
      booker: req.body?.booker,
      rooms,
      occupants: req.body?.occupants || [],
      currency: allocation.currency,
      rate_plan_id: allocation.rate_plan_id,
      rate_plan_name: allocation.rate_plan_name,
      meal_plan: allocation.meal_plan,
      financial_summary: req.body?.financial_summary || {
        room_total:
          allocation.negotiated_rate * quantity *
          Math.max(1, Math.ceil((block.check_out - block.check_in) / 86_400_000)),
        grand_total:
          allocation.negotiated_rate * quantity *
          Math.max(1, Math.ceil((block.check_out - block.check_in) / 86_400_000))
      },
      reservation_remarks: req.body?.reservation_remarks || "",
      guest_remarks: req.body?.guest_remarks || "",
      internal_remarks: req.body?.internal_remarks || "",
      business_block_id: block._id,
      business_block_allocation_id: allocation._id,
      created_by: actor,
      updated_by: actor
    });

    await record.validate();
    await validateReservationInventory({
      propertyId,
      checkIn: record.check_in,
      checkOut: record.check_out,
      rooms: record.rooms,
      linkedBusinessBlockId: block._id,
      session
    });
    await synchronizeGuestProfile(record, session);
    await record.save({ session });
    await writeAuditLog({
      propertyId,
      entityType: "reservation",
      entityId: record._id,
      action: "reservation_created_from_block",
      description: `Reservation ${record.reservation_no} was created from ${block.block_number}.`,
      actor,
      requestId: requestId(req),
      session
    });
    await ensureInvoiceForConfirmedReservation({
      reservation: record,
      requestId: requestId(req),
      session
    });
    await writeAuditLog({
      propertyId,
      entityType: "business_block",
      entityId: block._id,
      action: "reservation_picked_up",
      description: `${quantity} room(s) were picked up by reservation ${record.reservation_no}.`,
      actor,
      requestId: requestId(req),
      session
    });
    return record;
  });
  return res.status(201).json({
    message: "Reservation created from business block successfully.",
    reservation: serializeReservation(reservation)
  });
}));

router.get("/business-blocks/:blockId/rooming-list", asyncHandler(async (req, res) => {
  const block = await findBusinessBlock(req);
  if (!block) throw notFound("Business block not found.");
  const reservations = await Reservation.find({
    property_id: block.property_id,
    business_block_id: block._id,
    deleted_at: { $exists: false }
  }).sort({ reservation_date: -1 });
  return res.status(200).json({
    count: reservations.length,
    reservations: reservations.map(serializeReservation)
  });
}));

router.get("/business-blocks/:blockId/logs", asyncHandler(async (req, res) => {
  const block = await findBusinessBlock(req);
  if (!block) throw notFound("Business block not found.");
  const logs = await BookingAuditLog.find({
    property_id: block.property_id,
    entity_type: "business_block",
    entity_id: block._id
  }).sort({ created_at: -1 });
  return res.status(200).json({ count: logs.length, logs });
}));

router.use((error, _req, res, _next) => {
  if (error.type === "entity.too.large") {
    return res.status(413).json({ message: "The attachment exceeds the 10 MB limit." });
  }
  if (error.code === 11000) {
    return res.status(409).json({
      message: "That reservation number, block number, or unique value already exists."
    });
  }
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError ||
    error.name === "BSONError"
  ) {
    return res.status(400).json({
      message: "Booking data validation failed.",
      errors: Object.values(error.errors || {}).map(
        (validationError) => validationError.message
      )
    });
  }
  if (error instanceof mongoose.Error.VersionError) {
    return res.status(409).json({
      message: "This record was changed by another request. Reload it and try again."
    });
  }
  if (error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(error);
  return res.status(500).json({
    message: "The booking request could not be completed."
  });
});

async function transitionReservation(req, options) {
  const actor = actorFromRequest(req);
  return inTransaction(async (session) => {
    const reservation = await findReservation(req, session);
    if (!reservation) throw notFound("Reservation not found.");
    if (!options.from.includes(reservation.status)) {
      throw conflict(
        `A ${reservation.status} reservation cannot be changed to ${options.to}.`
      );
    }
    const currentRequestId = requestId(req);
    await options.beforeTransition?.({
      reservation,
      actor,
      requestId: currentRequestId,
      session
    });
    const previousStatus = reservation.status;
    reservation.status = options.to;
    reservation.updated_by = actor;
    options.mutate?.(reservation, actor);
    await reservation.save({ session });
    await writeAuditLog({
      propertyId: reservation.property_id,
      entityType: "reservation",
      entityId: reservation._id,
      action: options.action,
      description:
        options.description?.(reservation) ||
        `Reservation ${reservation.reservation_no} changed to ${options.to}.`,
      actor,
      changes: [{ field: "status", from: previousStatus, to: options.to }],
      requestId: currentRequestId,
      session
    });
    await ensureInvoiceForConfirmedReservation({
      reservation,
      requestId: currentRequestId,
      session
    });
    return reservation;
  });
}

async function transitionBusinessBlock(req, options) {
  const actor = actorFromRequest(req);
  return inTransaction(async (session) => {
    const block = await findBusinessBlock(req, session);
    if (!block) throw notFound("Business block not found.");
    if (!options.from.includes(block.status)) {
      throw conflict(
        `A ${block.status} business block cannot be changed to ${options.to}.`
      );
    }
    if (options.validate) {
      await options.validate({ block, excludeBlockId: block._id, session });
    }
    const previousStatus = block.status;
    block.status = options.to;
    block.updated_by = actor;
    await block.save({ session });
    await writeAuditLog({
      propertyId: block.property_id,
      entityType: "business_block",
      entityId: block._id,
      action: options.action,
      description:
        options.description?.(block) ||
        `Business block ${block.block_number} changed to ${options.to}.`,
      actor,
      changes: [{ field: "status", from: previousStatus, to: options.to }],
      requestId: requestId(req),
      session
    });
    return block;
  });
}

async function mutateAllocation(req, operation) {
  const actor = actorFromRequest(req);
  return inTransaction(async (session) => {
    const block = await findBusinessBlock(req, session);
    if (!block) throw notFound("Business block not found.");
    if (block.status !== "tentative") {
      throw conflict("Allocations can be changed only while the block is tentative.");
    }

    if (operation === "add") {
      block.allocations.push(req.body || {});
    } else {
      const allocation = block.allocations.id(req.params.allocationId);
      if (!allocation) throw notFound("Business-block allocation not found.");
      if (operation === "delete") {
        if (block.allocations.length === 1) {
          throw conflict("A business block must keep at least one allocation.");
        }
        allocation.deleteOne();
      } else {
        applyFields(allocation, req.body || {}, [
          "room_type_id",
          "room_type_name",
          "quantity",
          "rate_plan_id",
          "rate_plan_name",
          "meal_plan",
          "currency",
          "negotiated_rate",
          "tax_inclusive",
          "is_complimentary",
          "complimentary_reason",
          "released_quantity"
        ]);
      }
    }

    block.updated_by = actor;
    await enrichAndValidateAllocations(block, session);
    await block.save({ session });
    await writeAuditLog({
      propertyId: block.property_id,
      entityType: "business_block",
      entityId: block._id,
      action: `allocation_${operation === "delete" ? "removed" : operation === "add" ? "added" : "updated"}`,
      description: `A room allocation was ${operation === "delete" ? "removed" : operation === "add" ? "added" : "updated"}.`,
      actor,
      requestId: requestId(req),
      session
    });
    return block;
  });
}

async function enrichAndValidateAllocations(block, session) {
  await block.validate();
  const ids = [...new Set(block.allocations.map((item) => String(item.room_type_id)))];
  const roomTypes = await RoomType.find({
    property_id: block.property_id,
    _id: { $in: ids },
    active: true
  }).session(session || null);
  if (roomTypes.length !== ids.length) {
    throw conflict("One or more allocated room types do not exist or are disabled.");
  }
  const roomTypeMap = new Map(roomTypes.map((roomType) => [String(roomType._id), roomType]));
  for (const allocation of block.allocations) {
    const roomType = roomTypeMap.get(String(allocation.room_type_id));
    allocation.room_type_name = roomType.name;
    const physicalCount = roomType.physical_rooms.filter(
      (room) => room.active
    ).length;
    if (allocation.quantity > physicalCount) {
      throw conflict(
        `${roomType.name} has only ${physicalCount} active physical room(s).`
      );
    }
  }
  await block.validate();
}

async function synchronizeGuestProfile(reservation, session) {
  const email = String(reservation.booker.email || "").trim().toLowerCase();
  if (!email) return;
  const guest = await Guest.findOneAndUpdate(
    { property_id: reservation.property_id, email },
    {
      $set: {
        name: reservation.booker.name,
        phone: reservation.booker.phone,
        country: reservation.booker.country
      },
      $setOnInsert: {
        property_id: reservation.property_id,
        email
      }
    },
    { returnDocument: "after", upsert: true, runValidators: true, session }
  );
  reservation.booker.guest_profile_id = guest._id;
}

async function refreshPaidTotal(reservation, session) {
  const payments = await ReservationPayment.find({
    property_id: reservation.property_id,
    reservation_id: reservation._id,
    status: { $in: ["posted", "refunded"] }
  }).session(session);
  reservation.financial_summary.paid_total = Math.max(
    payments.reduce(
      (total, payment) =>
        total + (payment.status === "refunded" ? -payment.amount : payment.amount),
      0
    ),
    0
  );
  await reservation.save({ session });
}

function serializeReservationSummary(reservation) {
  const value = serializeReservation(reservation);
  return {
    _id: value._id,
    property_id: value.property_id,
    reservation_no: value.reservation_no,
    booking_reference: value.booking_reference,
    reservation_date: value.reservation_date,
    check_in: value.check_in,
    check_out: value.check_out,
    room_count: value.room_count,
    booking_source: value.booking_source,
    travel_agent: value.travel_agent,
    status: value.status,
    booker: value.booker,
    currency: value.currency,
    financial_summary: value.financial_summary,
    balance: value.balance,
    version: value.version
  };
}

function serializeReservation(reservation) {
  if (!reservation.toObject) return reservation;
  const value = reservation.toObject({ virtuals: true });
  value.version = value.__v;
  delete value.__v;
  return value;
}

function serializeBusinessBlock(block, metrics) {
  const value = block.toObject({ virtuals: true });
  value.version = value.__v;
  delete value.__v;
  value.metrics = metrics;
  value.allocations = value.allocations.map((allocation) => ({
    ...allocation,
    metrics: metrics.allocations.find(
      (item) => String(item.allocation_id) === String(allocation._id)
    )
  }));
  return value;
}

function serializeAttachment(attachment, req) {
  const value = attachment.toObject();
  value.file_url = `${req.protocol}://${req.get("host")}${req.baseUrl}/reservations/${attachment.reservation_id}/attachments/${attachment._id}/file?property_id=${encodeURIComponent(attachment.property_id)}`;
  return value;
}

function applyDateFilter(query, params) {
  const fieldMap = {
    check_in: "check_in",
    checkin: "check_in",
    check_out: "check_out",
    checkout: "check_out",
    reservation_date: "reservation_date",
    reservation: "reservation_date"
  };
  const field = fieldMap[normalizeEnum(params.date_field || params.date_filter_type)] || "check_in";
  if (params.date_from || params.date_to) query[field] = {};
  if (params.date_from) query[field].$gte = parseDate(params.date_from);
  if (params.date_to) query[field].$lte = endOfDate(params.date_to);
}

function reservationSort(value) {
  const sorts = {
    oldest: { reservation_date: 1, _id: 1 },
    check_in: { check_in: 1, _id: 1 },
    check_out: { check_out: 1, _id: 1 },
    reservation_no: { reservation_no: 1, _id: 1 }
  };
  return sorts[normalizeEnum(value)] || { reservation_date: -1, _id: -1 };
}

async function findReservation(req, session) {
  if (!mongoose.isValidObjectId(req.params.reservationId)) return null;
  const propertyId = getPropertyId(req);
  if (!propertyId) {
    throw badRequest(
      "property_id is required in the query, request body, or x-property-id header."
    );
  }
  const query = {
    _id: req.params.reservationId,
    property_id: propertyId,
    deleted_at: { $exists: false }
  };
  return Reservation.findOne(query).session(session || null);
}

async function findBusinessBlock(req, session) {
  if (!mongoose.isValidObjectId(req.params.blockId)) return null;
  const propertyId = getPropertyId(req);
  if (!propertyId) {
    throw badRequest(
      "property_id is required in the query, request body, or x-property-id header."
    );
  }
  const query = {
    _id: req.params.blockId,
    property_id: propertyId,
    deleted_at: { $exists: false }
  };
  return BusinessBlock.findOne(query).session(session || null);
}

async function findAttachment(reservation, attachmentId) {
  if (!mongoose.isValidObjectId(attachmentId)) return null;
  return ReservationAttachment.findOne({
    _id: attachmentId,
    property_id: reservation.property_id,
    reservation_id: reservation._id,
    deleted_at: { $exists: false }
  });
}

function requirePropertyId(req) {
  const propertyId = getPropertyId(req);
  if (!propertyId) {
    throw badRequest(
      "property_id is required in the query, request body, or x-property-id header."
    );
  }
  return propertyId;
}

function getPropertyId(req) {
  return String(
    req.query.property_id ||
    req.get("x-property-id") ||
    req.body?.property_id ||
    ""
  ).trim();
}

function applyFields(target, payload, fields) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      target[field] = payload[field];
    }
  }
}

function generateReference(prefix) {
  const date = new Date();
  const datePart = [
    String(date.getUTCFullYear()).slice(-2),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("");
  return `${prefix}-${datePart}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function getAttachmentBucket() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new Error("MongoDB is not connected.");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "reservation_attachments"
  });
}

function uploadGridFsFile(bucket, buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(options.filename, {
      contentType: options.contentType,
      metadata: options.metadata
    });
    stream.once("error", reject);
    stream.once("finish", () => resolve({ id: stream.id }));
    stream.end(buffer);
  });
}

async function deleteGridFsFile(bucket, fileId) {
  try {
    await bucket.delete(fileId);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function requestId(req) {
  return String(req.get("x-request-id") || "").trim();
}

function dateOnly(value) {
  const date = parseDate(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw badRequest(`Invalid date: ${value}`);
  return date;
}

function endOfDate(value) {
  const date = parseDate(value);
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeEnum(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeFilename(value) {
  return String(value || "attachment")
    .replace(/[\r\n"]/g, "")
    .replace(/[\\/]/g, "-")
    .slice(0, 255);
}

function badRequest(message) {
  return httpError(400, message);
}

function unsupportedMedia(message) {
  return httpError(415, message);
}

function notFound(message) {
  return httpError(404, message);
}

function conflict(message) {
  return httpError(409, message);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = router;
