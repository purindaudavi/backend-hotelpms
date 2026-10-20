const express = require("express");
const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const BookingAuditLog = require("../db_models/booking-log.model");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = req.authorizedProperty.property_id;
  const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 10));
  const provider = String(req.query.provider || "").trim().toLowerCase().slice(0, 80);
  const status = String(req.query.status || "").trim().toLowerCase().slice(0, 40);
  const search = String(req.query.search || "").trim().slice(0, 100);
  const baseQuery = {
    property_id: propertyId,
    "external_channel.provider": { $exists: true, $ne: "" },
    deleted_at: { $exists: false }
  };
  const query = { ...baseQuery };
  if (provider) query["external_channel.provider"] = provider;
  if (status) query.status = status;
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { reservation_no: pattern },
      { booking_reference: pattern },
      { "booker.name": pattern },
      { "external_channel.external_reservation_id": pattern }
    ];
  }

  const [records, total, providers] = await Promise.all([
    Reservation.find(query).sort({ reservation_date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Reservation.countDocuments(query),
    Reservation.distinct("external_channel.provider", baseQuery)
  ]);

  res.json({
    bookings: records.map((record) => serializeBooking(record, req.authorizedProperty.info?.hotel_name)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    providers: providers.filter(Boolean).sort()
  });
}));

router.get("/:bookingId", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.bookingId)) {
    return res.status(400).json({ message: "Invalid booking ID." });
  }
  const record = await Reservation.findOne({
    _id: req.params.bookingId,
    property_id: req.authorizedProperty.property_id,
    "external_channel.provider": { $exists: true, $ne: "" },
    deleted_at: { $exists: false }
  }).lean();
  if (!record) return res.status(404).json({ message: "Imported channel booking not found." });

  const history = await BookingAuditLog.find({
    property_id: req.authorizedProperty.property_id,
    entity_type: "reservation",
    entity_id: record._id
  }).sort({ created_at: 1, _id: 1 }).select("action description changes actor created_at").lean();

  return res.json({ booking: serializeBooking(record, req.authorizedProperty.info?.hotel_name, true), history });
}));

function serializeBooking(record, propertyName, details = false) {
  const booking = {
    id: String(record._id),
    reservation_no: record.reservation_no,
    unique_id: record.external_channel?.external_reservation_id || record.booking_reference || record.reservation_no,
    property_name: propertyName || record.property_id,
    source: record.booking_source || record.external_channel?.provider || "External channel",
    provider: record.external_channel?.provider || "",
    status: record.status,
    customer: record.booker?.name || "",
    booked_at: record.reservation_date,
    check_in: record.check_in,
    check_out: record.check_out,
    rooms_count: record.rooms?.length || 0,
    currency: record.currency || "",
    total: Number(record.financial_summary?.grand_total || 0),
    paid: Number(record.financial_summary?.paid_total || 0),
    pms_accepted: true,
    received_at: record.external_channel?.received_at || null
  };
  if (details) {
    booking.booker = record.booker || {};
    booking.rooms = (record.rooms || []).map((room) => ({
      room_type_name: room.room_type_name,
      room_number: room.room_number || "",
      rate_plan_name: room.rate_plan_name || "",
      meal_plan: room.meal_plan || "",
      nightly_rate: Number(room.effective_nightly_rate || 0)
    }));
    booking.guest_remarks = record.guest_remarks || "";
    booking.event_id = record.external_channel?.event_id || "";
  }
  return booking;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = router;
module.exports.serializeBooking = serializeBooking;
