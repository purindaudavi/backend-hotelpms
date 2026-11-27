const { createHash, randomBytes } = require("node:crypto");
const Property = require("../db_models/property.model");
const IbeSettings = require("../db_models/ibe-settings.model");
const { RatePlan } = require("../db_models/rates.model");
const Reservation = require("../db_models/booking.model");
const Guest = require("../db_models/guest.model");
const { money } = require("../db_models/invoice.model");
const { publicRatePlanFilter } = require("./ibe-settings.service");
const { quoteRatePlan } = require("./rate-quote.service");
const { validateReservationInventory } = require("./booking-availability.service");
const { withInventoryTransaction } = require("./inventory-transaction.service");
const { buildAccommodationLines } = require("./financial-document.service");
const { ensureInvoiceForConfirmedReservation } = require("./invoice-automation.service");
const { writeAuditLog } = require("./booking-audit.service");
const RoomType = require("../db_models/rooms.model");
const { sharingFor, requireSharing } = require("./ibe-sharing.service");

const DAY = 86_400_000;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const WEBSITE_ACTOR = { user_id: "website", name: "Guest booking website", email: "" };

async function loadPublicProperty(propertyId, session = null, includeBranding = false) {
  if (!/^[a-z\d][a-z\d_-]{0,99}$/i.test(propertyId) || propertyId.toLowerCase() === "demo") unavailable();
  const property = await Property.findOne({ property_id: propertyId, status: "active" }, { info: 1 }).session(session).lean();
  if (!property) unavailable();
  const projection = {
    "settings.config": 1, "settings.publicRatePlanId": 1,
    "settings.minStayRules": 1, "settings.policies": 1, "settings.publicSharing": 1
  };
  if (includeBranding) {
    Object.assign(projection, {
      "settings.logoImage": 1, "settings.ibeHomeImage": 1,
      "settings.bannerOffsetX": 1, "settings.bannerOffsetY": 1, "settings.bannerScale": 1
    });
  }
  const settings = (await IbeSettings.findById(propertyId, projection).session(session).lean())?.settings;
  if (!settings?.config?.ibeActive || !settings.config.payAtProperty || !OBJECT_ID.test(settings.publicRatePlanId)) unavailable();
  const plan = await RatePlan.findOne(publicRatePlanFilter(propertyId, settings.publicRatePlanId))
    .select("room_type_rates.room_type_id").session(session).lean();
  if (!plan) unavailable();
  return { info: property.info, settings, plan, today: todayAt(property.info.timezone) };
}

async function publicPropertyDetails(propertyId) {
  const { info, settings, today } = await loadPublicProperty(propertyId, null, true);
  const sharing = sharingFor(settings);
  return {
    today,
    childFriendly: settings.config.childFriendly,
    capabilities: { availability: sharing.availability, bookings: sharing.availability && sharing.bookings },
    ...(sharing.hotelDetails ? { name: info.hotel_name, location: [info.city, info.country_code].filter(Boolean).join(", ") } : {}),
    ...(sharing.policies ? { childPolicy: settings.policies?.childPolicy || "" } : {}),
    ...(sharing.branding ? {
      headerColour: settings.config.headerColour,
      logo: settings.logoImage || "",
      banner: settings.ibeHomeImage || "",
      bannerPosition: {
        x: settings.bannerOffsetX || 0, y: settings.bannerOffsetY || 0, scale: settings.bannerScale || 1
      }
    } : {}),
    ...(sharing.stayTimes ? {
      checkIn: [info.check_in_time_from || info.check_in_time, info.check_in_time_to].filter(Boolean).join(" to "),
      checkOut: [info.check_out_time_from || info.check_out_time, info.check_out_time_to].filter(Boolean).join(" to ")
    } : {})
  };
}

async function searchPublicRooms(propertyId, input) {
  const context = await loadPublicProperty(propertyId);
  requireSharing(context.settings, "availability");
  const stay = parseStay(input, context);
  const roomIds = [...new Set(context.plan.room_type_rates.map((entry) => String(entry.room_type_id)))];
  const offers = [];
  for (let index = 0; index < roomIds.length; index += 4) {
    const batch = roomIds.slice(index, index + 4);
    const results = await Promise.allSettled(batch.map((roomTypeId) => quoteAvailableRoom(propertyId, context, stay, roomTypeId)));
    for (const result of results) {
      if (result.status === "fulfilled") offers.push(result.value.offer);
      else if (![404, 409].includes(result.reason.statusCode)) throw result.reason;
    }
  }
  return { offers };
}

async function createPublicBooking(propertyId, input) {
  const roomTypeId = typeof input?.roomTypeId === "string" ? input.roomTypeId.toLowerCase() : "";
  if (!OBJECT_ID.test(roomTypeId)) throw fail(400, "Select an available room.");
  const requestKey = input?.requestKey;
  const offerKey = input?.offerKey;
  if (typeof requestKey !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(requestKey)
      || typeof offerKey !== "string" || !/^[a-f\d]{64}$/.test(offerKey)) {
    throw fail(400, "Search for a room and select its latest offer before booking.");
  }
  const context = await loadPublicProperty(propertyId);
  const stay = parseStay(input, context, { checkCurrentDates: false });
  const booker = await parseContact(propertyId, input.guest);
  const id = hash([propertyId, requestKey.toLowerCase()]).slice(0, 24);
  const fingerprint = hash([stay, roomTypeId, offerKey, booker]);
  return withInventoryTransaction(propertyId, async (session) => {
    const published = await loadPublicProperty(propertyId, session);
    const existing = await Reservation.findOne({ _id: id, property_id: propertyId })
      .select("+website_booking_fingerprint").session(session).lean();
    if (existing) {
      if (existing.website_booking_fingerprint !== fingerprint) throw fail(409, "This booking attempt already used different details. Search again.");
      return { created: false, booking: bookingReceipt(existing, published.info.hotel_name, published.settings) };
    }

    requireSharing(published.settings, "availability");
    requireSharing(published.settings, "bookings");

    parseStay(input, published);
    let quoted;
    try {
      quoted = await quoteAvailableRoom(propertyId, published, stay, roomTypeId, session);
    } catch (error) {
      if ([404, 409].includes(error.statusCode)) throw fail(409, "That room is no longer available for this stay. Search again.");
      throw error;
    }
    const { quote, offer, room } = quoted;
    if (offer.offerKey !== offerKey) throw fail(409, "The price or terms changed. Search again to see the latest offer.");

    // A public form can create a new profile, but cannot change an existing one.
    const guest = await Guest.findOneAndUpdate(
      { property_id: propertyId, email: booker.email },
      { $setOnInsert: { property_id: propertyId, ...booker } },
      { upsert: true, returnDocument: "after", runValidators: true, session }
    );
    const reference = "RES-WEB-" + randomBytes(8).toString("hex").toUpperCase();
    const reservation = new Reservation({
      _id: id,
      property_id: propertyId,
      reservation_no: reference,
      booking_reference: reference,
      website_booking_fingerprint: fingerprint,
      status: "confirmed",
      booking_source: "Website",
      check_in: stay.checkIn,
      check_out: stay.checkOut,
      booker: { ...booker, guest_profile_id: guest._id },
      rooms: [{
        ...room,
        room_type_name: offer.roomName,
        occupancy: ["Single", "Double", "Triple"][stay.adults + stay.children - 1] || "Family",
        rate_plan_id: String(quote.rate_plan_id),
        rate_plan_name: quote.rate_plan_name,
        meal_plan: quote.meal_plan,
        currency: offer.currency,
        original_nightly_rate: money(quote.average_nightly_rate),
        effective_nightly_rate: money(quote.average_nightly_rate)
      }],
      currency: offer.currency,
      rate_plan_id: String(quote.rate_plan_id),
      rate_plan_name: quote.rate_plan_name,
      meal_plan: quote.meal_plan,
      refundable: quote.refundable,
      cancellation_policy: (published.settings.policies?.cancellationPolicy || quote.cancellation_policy).slice(0, 3000),
      financial_summary: { room_total: offer.total, grand_total: offer.total, paid_total: 0 },
      created_by: WEBSITE_ACTOR,
      updated_by: WEBSITE_ACTOR
    });
    await reservation.save({ session });

    const [accommodation] = buildAccommodationLines(reservation);
    const lineItems = quote.nightly_rates.map((rate) => ({
      ...accommodation,
      service_date: new Date(rate.date),
      exact_service_date: true,
      description: offer.roomName + " - " + rate.date,
      quantity: 1,
      unit_price: rate.amount
    }));
    await ensureInvoiceForConfirmedReservation({ reservation, session, lineItems, billingSnapshot: booker });
    await writeAuditLog({
      propertyId, entityType: "reservation", entityId: reservation._id,
      action: "reservation_created", description: `Reservation ${reference} booked through the property website.`,
      actor: WEBSITE_ACTOR, session
    });
    return { created: true, booking: bookingReceipt(reservation, published.info.hotel_name, published.settings) };
  });
}

async function quoteAvailableRoom(propertyId, context, stay, roomTypeId, session = null) {
  const quote = await quoteRatePlan({ ...stay, propertyId, ratePlanId: String(context.plan._id), roomTypeId, session });
  if (quote.meal_plan !== "Room Only") throw fail(409, "This rate is unavailable.");
  const rules = context.settings.minStayRules || {};
  if (quote.nightly_rates.some(({ date }) => quote.nights < (rules[roomTypeId + "::" + date] || 0))) {
    throw fail(409, "A longer stay is required for this room.");
  }
  const room = { room_type_id: roomTypeId, adults: stay.adults, children: stay.children };
  await validateReservationInventory({ propertyId, ...stay, rooms: [room], session });

  const sharing = sharingFor(context.settings);
  const details = sharing.roomDetails ? await RoomType.findOne({ _id: roomTypeId, property_id: propertyId })
    .select("description amenities maximum_adults maximum_children").session(session).lean() : null;
  const offer = {
    roomTypeId,
    roomName: quote.room_type_name,
    nights: quote.nights,
    currency: quote.currency,
    total: money(quote.total),
    ...(sharing.roomDetails ? {
      description: details?.description || "", amenities: details?.amenities || [],
      maximumAdults: details?.maximum_adults, maximumChildren: details?.maximum_children
    } : {}),
    ...(sharing.policies ? {
      refundable: quote.refundable,
      cancellationPolicy: (context.settings.policies?.cancellationPolicy || quote.cancellation_policy).slice(0, 3000),
      conditions: [context.settings.policies?.childPolicy, context.settings.policies?.taxPolicy].filter(Boolean)
    } : {}),
    offerKey: ""
  };
  offer.offerKey = hash([propertyId, stay, String(quote.rate_plan_id), offer, quote.nightly_rates.map(({ amount }) => amount)]);
  return { quote, offer, room };
}

function parseStay(input, context, { checkCurrentDates = true } = {}) {
  const checkIn = validDate(input?.checkIn);
  const checkOut = validDate(input?.checkOut);
  const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / DAY;
  if (nights < 1 || nights > 30) throw fail(400, "Choose a stay of 1 to 30 nights.");
  if (checkCurrentDates && (checkIn < context.today || Date.parse(checkOut) > Date.parse(context.today) + 365 * DAY)) {
    throw fail(400, "Choose dates from today through the next 365 days.");
  }
  const adults = guestCount(input.adults ?? 1, 1);
  const children = guestCount(input.children ?? 0, 0);
  if (checkCurrentDates && children && !context.settings.config.childFriendly) throw fail(400, "This property does not accept child guests through online booking.");
  return { checkIn, checkOut, adults, children };
}

function guestCount(value, minimum) {
  const count = typeof value === "number" || (typeof value === "string" && /^(?:0|[1-9]\d?)$/.test(value))
    ? Number(value) : NaN;
  if (!Number.isInteger(count) || count < minimum || count > 30) throw fail(400, "Enter a valid guest count.");
  return count;
}

function validDate(value) {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw fail(400, "Enter valid check-in and check-out dates.");
  }
  return value;
}

async function parseContact(propertyId, input) {
  const guest = new Guest({
    property_id: propertyId,
    name: normalizedText(input?.name),
    email: normalizedText(input?.email),
    phone: normalizedText(input?.phone),
    country: normalizedText(input?.country)
  });
  try {
    await guest.validate();
  } catch (error) {
    if (error.name !== "ValidationError") throw error;
    throw fail(400, Object.values(error.errors)[0].message);
  }
  return { name: guest.name, email: guest.email, phone: guest.phone, country: guest.country };
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function bookingReceipt(reservation, propertyName, settings) {
  return {
    reference: reservation.reservation_no,
    ...(sharingFor(settings).hotelDetails ? { propertyName } : {}),
    roomName: reservation.rooms[0]?.room_type_name || "",
    checkIn: reservation.check_in.toISOString().slice(0, 10),
    checkOut: reservation.check_out.toISOString().slice(0, 10),
    status: reservation.status,
    currency: reservation.currency,
    total: reservation.financial_summary.grand_total
  };
}

function todayAt(timeZone) {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: timeZone || "UTC" }).format();
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" }).format();
  }
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unavailable() {
  throw fail(404, "Online booking is unavailable for this property.");
}

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = { publicPropertyDetails, searchPublicRooms, createPublicBooking };
