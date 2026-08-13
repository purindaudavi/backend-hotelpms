const mongoose = require("mongoose");
const RoomType = require("../db_models/rooms.model");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const { MealAllocation } = require("../db_models/property.model");

const MAX_QUOTE_NIGHTS = 365;

async function quoteRatePlan({
  propertyId,
  ratePlanId,
  roomTypeId,
  checkIn,
  checkOut,
  adults = 1,
  children = 0,
  dayRoom = false,
  allowInactive = false
}) {
  if (!mongoose.isValidObjectId(ratePlanId)) {
    throw httpError(400, "rate_plan_id must be a valid MongoDB ObjectId.");
  }
  if (!mongoose.isValidObjectId(roomTypeId)) {
    throw httpError(400, "room_type_id must be a valid MongoDB ObjectId.");
  }

  const arrival = parseDateOnly(checkIn, "check_in");
  const departure = parseDateOnly(checkOut, "check_out");
  if (!dayRoom && departure <= arrival) {
    throw httpError(400, "check_out must be after check_in.");
  }
  if (dayRoom && departure < arrival) {
    throw httpError(400, "A day-room check_out cannot be before check_in.");
  }

  const stayDates = dayRoom
    ? [arrival]
    : enumerateStayDates(arrival, departure, MAX_QUOTE_NIGHTS);

  const [plan, roomType] = await Promise.all([
    RatePlan.findOne({ _id: ratePlanId, property_id: propertyId }),
    RoomType.findOne({ _id: roomTypeId, property_id: propertyId })
  ]);
  if (!plan) throw httpError(404, "Rate plan not found for this property.");
  if (!roomType) throw httpError(404, "Room type not found for this property.");
  if (!allowInactive && !plan.active) {
    throw httpError(409, "This rate plan is disabled and cannot be quoted.", "RATE_PLAN_DISABLED");
  }
  if (!roomType.active) {
    throw httpError(409, "This room type is disabled and cannot be quoted.", "ROOM_TYPE_DISABLED");
  }

  const occupancy = occupancyPrice(roomType, adults, children);

  const planStart = startOfUtcDay(plan.valid_from);
  const planEnd = startOfUtcDay(plan.valid_to);
  const uncoveredDate = stayDates.find((date) => date < planStart || date > planEnd);
  if (uncoveredDate) {
    throw httpError(
      409,
      `The rate plan does not cover ${dateKey(uncoveredDate)}.`,
      "RATE_PLAN_OUTSIDE_VALIDITY"
    );
  }

  const roomTypeRate = plan.room_type_rates.find(
    (rate) => String(rate.room_type_id) === String(roomType._id)
  );
  if (!roomTypeRate) {
    throw httpError(
      409,
      `The rate plan has no price for room type ${roomType.name}.`,
      "RATE_NOT_CONFIGURED"
    );
  }

  const restrictionEnd = dayRoom ? arrival : departure;
  const overrides = await DailyRate.find({
    property_id: propertyId,
    rate_plan_id: plan._id,
    room_type_id: roomType._id,
    date: { $gte: arrival, $lte: restrictionEnd }
  }).sort({ date: 1 });
  const overridesByDate = new Map(
    overrides.map((override) => [dateKey(override.date), override])
  );

  const arrivalRule = overridesByDate.get(dateKey(arrival));
  if (arrivalRule?.closed_to_arrival) {
    throw httpError(409, "This rate is closed to arrival on the check-in date.", "CLOSED_TO_ARRIVAL");
  }
  const departureRule = overridesByDate.get(dateKey(departure));
  if (!dayRoom && departureRule?.closed_to_departure) {
    throw httpError(409, "This rate is closed to departure on the check-out date.", "CLOSED_TO_DEPARTURE");
  }

  const stayLength = stayDates.length;
  for (const date of stayDates) {
    const override = overridesByDate.get(dateKey(date));
    if (override?.stop_sell) {
      throw httpError(409, `This rate is closed for sale on ${dateKey(date)}.`, "RATE_STOP_SELL");
    }
    if (override && stayLength < override.minimum_stay) {
      throw httpError(
        409,
        `A minimum stay of ${override.minimum_stay} night(s) applies on ${dateKey(date)}.`,
        "MINIMUM_STAY_NOT_MET"
      );
    }
    if (override?.maximum_stay && stayLength > override.maximum_stay) {
      throw httpError(
        409,
        `A maximum stay of ${override.maximum_stay} night(s) applies on ${dateKey(date)}.`,
        "MAXIMUM_STAY_EXCEEDED"
      );
    }
  }

  const nightlyRates = stayDates.map((date) => {
    const override = overridesByDate.get(dateKey(date));
    const baseAmount = override ? override.amount : roomTypeRate.amount;
    return {
      date: dateKey(date),
      base_amount: baseAmount,
      occupancy_supplement: occupancy.nightly_supplement,
      amount: money(baseAmount + occupancy.nightly_supplement),
      source: override ? "daily_rate" : "rate_plan"
    };
  });
  const total = nightlyRates.reduce((sum, rate) => sum + rate.amount, 0);
  const mealAllocation = await resolveMealAllocationForQuote({
    plan,
    propertyId,
    stayDates
  });

  return {
    property_id: propertyId,
    rate_plan_id: plan._id,
    rate_plan_name: plan.name,
    rate_plan_code: plan.code,
    room_type_id: roomType._id,
    room_type_name: roomType.name,
    currency: plan.currency,
    meal_plan: plan.meal_plan,
    occupancy_pricing: occupancy,
    meal_allocation: mealAllocation ? serializeMealAllocation(mealAllocation) : null,
    refundable: plan.refundable,
    cancellation_policy: plan.cancellation_policy,
    check_in: dateKey(arrival),
    check_out: dateKey(departure),
    day_room: Boolean(dayRoom),
    nights: stayLength,
    nightly_rates: nightlyRates,
    average_nightly_rate: stayLength ? total / stayLength : 0,
    total
  };
}

function occupancyPrice(roomType, adultsValue, childrenValue) {
  const adults = wholeNumber(adultsValue, "adults", 1);
  const children = wholeNumber(childrenValue, "children", 0);
  if (adults > roomType.maximum_adults) {
    throw httpError(
      409,
      `${roomType.name} allows at most ${roomType.maximum_adults} adult(s).`,
      "ADULT_CAPACITY_EXCEEDED"
    );
  }
  if (children > roomType.maximum_children) {
    throw httpError(
      409,
      `${roomType.name} allows at most ${roomType.maximum_children} child(ren).`,
      "CHILD_CAPACITY_EXCEEDED"
    );
  }
  const includedAdults = Number(roomType.included_adults ?? 1);
  const includedChildren = Number(roomType.included_children ?? 0);
  const extraAdults = Math.max(adults - includedAdults, 0);
  const extraChildren = Math.max(children - includedChildren, 0);
  const extraAdultRate = Number(roomType.extra_adult_rate || 0);
  const extraChildRate = Number(roomType.extra_child_rate || 0);
  return {
    adults,
    children,
    included_adults: includedAdults,
    included_children: includedChildren,
    extra_adults: extraAdults,
    extra_children: extraChildren,
    extra_adult_rate: extraAdultRate,
    extra_child_rate: extraChildRate,
    nightly_supplement: money(
      extraAdults * extraAdultRate + extraChildren * extraChildRate
    )
  };
}

function wholeNumber(value, field, minimum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw httpError(400, `${field} must be a whole number of at least ${minimum}.`);
  }
  return number;
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function resolveMealAllocationForQuote({ plan, propertyId, stayDates }) {
  if (plan.meal_plan === "Room Only") return null;
  if (!plan.meal_allocation_id) {
    throw httpError(
      409,
      "This meal-inclusive rate plan is not linked to a meal allocation.",
      "MEAL_ALLOCATION_NOT_CONFIGURED"
    );
  }
  const allocation = await MealAllocation.findOne({
    _id: plan.meal_allocation_id,
    property_id: propertyId
  });
  if (!allocation || !allocation.active) {
    throw httpError(409, "The linked meal allocation is unavailable.", "MEAL_ALLOCATION_UNAVAILABLE");
  }
  if (allocation.meal_plan !== plan.meal_plan || allocation.currency !== plan.currency) {
    throw httpError(409, "The linked meal allocation does not match this rate plan.", "MEAL_ALLOCATION_MISMATCH");
  }
  const allocationStart = startOfUtcDay(allocation.valid_from);
  const allocationEnd = startOfUtcDay(allocation.valid_to);
  const uncoveredDate = stayDates.find((date) => date < allocationStart || date > allocationEnd);
  if (uncoveredDate) {
    throw httpError(
      409,
      `The linked meal allocation does not cover ${dateKey(uncoveredDate)}.`,
      "MEAL_ALLOCATION_OUTSIDE_VALIDITY"
    );
  }
  return allocation;
}

function serializeMealAllocation(allocation) {
  return {
    _id: allocation._id,
    name: allocation.name,
    meal_plan: allocation.meal_plan,
    currency: allocation.currency,
    adult_amounts: allocation.adult_amounts,
    child_amounts: allocation.child_amounts,
    valid_from: dateKey(allocation.valid_from),
    valid_to: dateKey(allocation.valid_to)
  };
}

function parseDateOnly(value, fieldName = "date") {
  const input = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw httpError(400, `${fieldName} must use YYYY-MM-DD format.`);
  }
  const date = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || dateKey(date) !== input) {
    throw httpError(400, `${fieldName} is not a valid calendar date.`);
  }
  return date;
}

function enumerateStayDates(checkIn, checkOut, maximumNights = MAX_QUOTE_NIGHTS) {
  const dates = [];
  for (
    let cursor = new Date(checkIn);
    cursor < checkOut;
    cursor = addUtcDays(cursor, 1)
  ) {
    dates.push(cursor);
    if (dates.length > maximumNights) {
      throw httpError(400, `A quote cannot exceed ${maximumNights} nights.`);
    }
  }
  return dates;
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function addUtcDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function startOfUtcDay(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

module.exports = {
  MAX_QUOTE_NIGHTS,
  quoteRatePlan,
  parseDateOnly,
  enumerateStayDates,
  dateKey,
  addUtcDays,
  httpError
};
