const crypto = require("crypto");
const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const Guest = require("../db_models/guest.model");
const { quoteRatePlan, parseDateOnly } = require("./rate-quote.service");
const {
  validateReservationInventory
} = require("./booking-availability.service");
const {
  applyReservationMealAllocationSnapshots
} = require("./meal-allocation.service");
const {
  ensureInvoiceForConfirmedReservation
} = require("./invoice-automation.service");
const { writeAuditLog } = require("./booking-audit.service");

const SUPPORTED_STATUSES = new Set(["tentative", "confirmed"]);
const PROVIDER_NAMES = {
  "booking.com": "Booking.com",
  bookingcom: "Booking.com",
  agoda: "Agoda",
  expedia: "Expedia",
  airbnb: "Airbnb"
};

function normalizeOtaReservationInput(input = {}) {
  const propertyId = requiredText(input.property_id, "property_id", 100);
  const provider = requiredText(input.provider, "provider", 80).toLowerCase();
  const externalReservationId = requiredText(
    input.external_reservation_id,
    "external_reservation_id",
    160
  );
  const status = String(input.status || "confirmed").trim().toLowerCase();
  if (!SUPPORTED_STATUSES.has(status)) {
    throw httpError(400, "status must be tentative or confirmed.");
  }

  const checkIn = parseDateOnly(input.check_in, "check_in");
  const checkOut = parseDateOnly(input.check_out, "check_out");
  if (checkOut <= checkIn) {
    throw httpError(400, "check_out must be after check_in.");
  }

  const guest = input.guest || {};
  const bookedAt = input.booked_at ? new Date(input.booked_at) : new Date();
  if (Number.isNaN(bookedAt.getTime())) {
    throw httpError(400, "booked_at must be a valid date and time.");
  }

  if (!Array.isArray(input.rooms) || input.rooms.length === 0) {
    throw httpError(400, "rooms must contain at least one room request.");
  }
  const rooms = input.rooms.map((room, index) => {
    const ratePlanId = requiredObjectId(room.rate_plan_id, `rooms[${index}].rate_plan_id`);
    const roomTypeId = requiredObjectId(room.room_type_id, `rooms[${index}].room_type_id`);
    return {
      rate_plan_id: ratePlanId,
      room_type_id: roomTypeId,
      adults: wholeNumber(room.adults ?? 1, `rooms[${index}].adults`, 1, 30),
      children: wholeNumber(room.children ?? 0, `rooms[${index}].children`, 0, 30),
      quantity: wholeNumber(room.quantity ?? 1, `rooms[${index}].quantity`, 1, 20)
    };
  });
  const planIds = new Set(rooms.map((room) => room.rate_plan_id));
  if (planIds.size !== 1) {
    throw httpError(400, "All rooms in one simulated reservation must use the same rate plan.");
  }

  return {
    property_id: propertyId,
    provider,
    external_reservation_id: externalReservationId,
    event_id: optionalText(input.event_id, 160),
    status,
    booked_at: bookedAt,
    check_in: checkIn,
    check_out: checkOut,
    guest: {
      title: optionalText(guest.title, 30),
      name: requiredText(guest.name, "guest.name", 150),
      email: requiredText(guest.email, "guest.email", 254).toLowerCase(),
      phone: requiredText(guest.phone, "guest.phone", 40),
      country: requiredText(guest.country, "guest.country", 100)
    },
    rooms,
    guest_remarks: optionalText(input.guest_remarks, 3000),
    special_requests: optionalText(input.special_requests, 3000)
  };
}

async function createSimulatedOtaReservation(input, { requestId = "" } = {}) {
  const payload = normalizeOtaReservationInput(input);
  const duplicate = await findExisting(payload);
  if (duplicate) return { created: false, reservation: duplicate, invoice: null };

  const quotes = await Promise.all(payload.rooms.map((room) => quoteRatePlan({
    propertyId: payload.property_id,
    ratePlanId: room.rate_plan_id,
    roomTypeId: room.room_type_id,
    checkIn: isoDate(payload.check_in),
    checkOut: isoDate(payload.check_out),
    adults: room.adults,
    children: room.children
  })));
  const currencies = new Set(quotes.map((quote) => quote.currency));
  if (currencies.size !== 1) {
    throw httpError(409, "All requested rooms must use the same currency.");
  }

  try {
    return await inTransaction(async (session) => {
      const existing = await findExisting(payload, session);
      if (existing) return { created: false, reservation: existing, invoice: null };

      const guest = await upsertGuest(payload, session);
      const actor = simulatorActor(payload.provider);
      const roomLines = [];
      let roomTotal = 0;
      payload.rooms.forEach((room, index) => {
        const quote = quotes[index];
        for (let count = 0; count < room.quantity; count += 1) {
          roomLines.push({
            room_type_id: quote.room_type_id,
            room_type_name: quote.room_type_name,
            occupancy: `${room.adults} adult(s), ${room.children} child(ren)`,
            adults: room.adults,
            children: room.children,
            rate_plan_id: String(quote.rate_plan_id),
            rate_plan_name: quote.rate_plan_name,
            meal_plan: quote.meal_plan,
            currency: quote.currency,
            original_nightly_rate: money(quote.average_nightly_rate),
            effective_nightly_rate: money(quote.average_nightly_rate)
          });
          roomTotal += quote.total;
        }
      });

      const firstQuote = quotes[0];
      const reservation = new Reservation({
        property_id: payload.property_id,
        reservation_no: generateReservationNumber(),
        booking_reference: payload.external_reservation_id,
        reservation_date: payload.booked_at,
        check_in: payload.check_in,
        check_out: payload.check_out,
        status: payload.status,
        booking_source: providerDisplayName(payload.provider),
        external_channel: {
          provider: payload.provider,
          external_reservation_id: payload.external_reservation_id,
          event_id: payload.event_id,
          received_at: new Date()
        },
        booker: { ...payload.guest, guest_profile_id: guest._id },
        rooms: roomLines,
        currency: firstQuote.currency,
        rate_plan_id: String(firstQuote.rate_plan_id),
        rate_plan_name: firstQuote.rate_plan_name,
        meal_plan: firstQuote.meal_plan,
        refundable: firstQuote.refundable,
        cancellation_policy: firstQuote.cancellation_policy,
        financial_summary: {
          room_total: money(roomTotal),
          tax_total: 0,
          discount_total: 0,
          extra_charge_total: 0,
          grand_total: money(roomTotal),
          paid_total: 0
        },
        guest_remarks: payload.guest_remarks,
        internal_remarks: [
          `Imported through the simulated ${providerDisplayName(payload.provider)} OTA endpoint.`,
          payload.special_requests
        ].filter(Boolean).join("\n"),
        created_by: actor,
        updated_by: actor
      });

      await applyReservationMealAllocationSnapshots({
        reservation,
        requireConfigured: true,
        session
      });
      await reservation.validate();
      await validateReservationInventory({
        propertyId: reservation.property_id,
        checkIn: reservation.check_in,
        checkOut: reservation.check_out,
        rooms: reservation.rooms,
        session
      });
      await reservation.save({ session });
      await writeAuditLog({
        propertyId: reservation.property_id,
        entityType: "reservation",
        entityId: reservation._id,
        action: "ota_reservation_imported",
        description:
          `${providerDisplayName(payload.provider)} test reservation ` +
          `${payload.external_reservation_id} was imported by the OTA simulator.`,
        actor,
        requestId,
        session
      });
      const invoiceResult = await ensureInvoiceForConfirmedReservation({
        reservation,
        requestId,
        session
      });
      return {
        created: true,
        reservation,
        invoice: invoiceResult.invoice
      };
    });
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await findExisting(payload);
      if (existing) return { created: false, reservation: existing, invoice: null };
    }
    throw error;
  }
}

async function findSimulatedOtaReservation({ propertyId, provider, externalReservationId }) {
  return Reservation.findOne({
    property_id: requiredText(propertyId, "property_id", 100),
    "external_channel.provider": requiredText(provider, "provider", 80).toLowerCase(),
    "external_channel.external_reservation_id": requiredText(
      externalReservationId,
      "external_reservation_id",
      160
    ),
    deleted_at: { $exists: false }
  });
}

function findExisting(payload, session) {
  return Reservation.findOne({
    property_id: payload.property_id,
    "external_channel.provider": payload.provider,
    "external_channel.external_reservation_id": payload.external_reservation_id,
    deleted_at: { $exists: false }
  }).session(session || null);
}

async function upsertGuest(payload, session) {
  return Guest.findOneAndUpdate(
    { property_id: payload.property_id, email: payload.guest.email },
    {
      $set: {
        name: payload.guest.name,
        phone: payload.guest.phone,
        country: payload.guest.country
      },
      $setOnInsert: {
        property_id: payload.property_id,
        email: payload.guest.email
      }
    },
    { returnDocument: "after", upsert: true, runValidators: true, session }
  );
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

function providerDisplayName(provider) {
  return PROVIDER_NAMES[String(provider || "").trim().toLowerCase()] ||
    String(provider || "OTA").trim();
}

function simulatorActor(provider) {
  const name = providerDisplayName(provider);
  return { user_id: `ota:${provider}`, name: `${name} OTA Simulator`, email: "" };
}

function generateReservationNumber() {
  const now = new Date();
  const date = `${String(now.getUTCFullYear()).slice(-2)}` +
    `${String(now.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(now.getUTCDate()).padStart(2, "0")}`;
  return `RES-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function requiredText(value, field, maximum) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) throw httpError(400, `${field} is required.`);
  if (text.length > maximum) throw httpError(400, `${field} is too long.`);
  return text;
}

function optionalText(value, maximum) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length > maximum) throw httpError(400, "A text value is too long.");
  return text;
}

function requiredObjectId(value, field) {
  const id = String(value || "").trim();
  if (!mongoose.isValidObjectId(id)) {
    throw httpError(400, `${field} must be a valid MongoDB ObjectId.`);
  }
  return id;
}

function wholeNumber(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw httpError(400, `${field} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return number;
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

module.exports = {
  createSimulatedOtaReservation,
  findSimulatedOtaReservation,
  normalizeOtaReservationInput,
  providerDisplayName
};
