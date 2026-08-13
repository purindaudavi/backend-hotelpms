const mongoose = require("mongoose");
const { RatePlan } = require("../db_models/rates.model");
const { MealAllocation } = require("../db_models/property.model");

const MEALS = ["breakfast", "lunch", "dinner"];

async function applyReservationMealAllocationSnapshots({
  reservation,
  requireConfigured = false,
  session
}) {
  const ratePlanIds = [...new Set(
    reservation.rooms
      .filter((room) => room.meal_plan && room.meal_plan !== "Room Only")
      .map((room) => String(room.rate_plan_id || ""))
      .filter(Boolean)
  )];

  if (ratePlanIds.some((id) => !mongoose.isValidObjectId(id))) {
    if (requireConfigured) throw httpError(400, "Every meal-inclusive room requires a valid rate plan.");
    return reservation;
  }

  const planQuery = RatePlan.find({
    _id: { $in: ratePlanIds },
    property_id: reservation.property_id
  });
  if (session) planQuery.session(session);
  const plans = await planQuery;
  const plansById = new Map(plans.map((plan) => [String(plan._id), plan]));
  const allocationIds = [...new Set(
    plans.map((plan) => String(plan.meal_allocation_id || "")).filter(Boolean)
  )];
  const allocationQuery = MealAllocation.find({
    _id: { $in: allocationIds },
    property_id: reservation.property_id
  });
  if (session) allocationQuery.session(session);
  const allocations = await allocationQuery;
  const allocationsById = new Map(
    allocations.map((allocation) => [String(allocation._id), allocation])
  );

  const stayStart = startOfUtcDay(reservation.check_in);
  const lastMealDate = reservation.is_day_room
    ? stayStart
    : addUtcDays(startOfUtcDay(reservation.check_out), -1);

  for (const room of reservation.rooms) {
    if (!room.meal_plan || room.meal_plan === "Room Only") {
      room.meal_allocation_snapshot = undefined;
      continue;
    }

    const plan = plansById.get(String(room.rate_plan_id || ""));
    const allocation = plan?.meal_allocation_id
      ? allocationsById.get(String(plan.meal_allocation_id))
      : null;

    // Keep the price split that was captured when an existing reservation was
    // created. Editing or retiring the allocation later must not rewrite history.
    const existingSnapshot = room.meal_allocation_snapshot;
    const existingAllocationId = String(existingSnapshot?.meal_allocation_id || "");
    const currentAllocationId = String(plan?.meal_allocation_id || "");
    if (
      !requireConfigured &&
      existingSnapshot &&
      (!plan || (
        existingAllocationId === currentAllocationId &&
        existingSnapshot.meal_plan === room.meal_plan &&
        existingSnapshot.currency === room.currency
      ))
    ) {
      assertMealAllocationFitsNightlyRate(room, existingSnapshot);
      continue;
    }

    if (!plan || !allocation) {
      if (room.meal_allocation_snapshot && !requireConfigured) continue;
      if (!requireConfigured) continue;
      throw httpError(
        409,
        `${room.rate_plan_name || "The selected rate plan"} is not linked to a meal allocation.`
      );
    }
    if (!allocation.active) {
      throw httpError(409, `Meal allocation ${allocation.name} is retired.`);
    }
    if (plan.meal_plan !== room.meal_plan || allocation.meal_plan !== room.meal_plan) {
      throw httpError(409, "The reservation meal plan must match its rate plan and meal allocation.");
    }
    if (plan.currency !== room.currency || allocation.currency !== room.currency) {
      throw httpError(409, "The reservation room, rate plan, and meal allocation must use one currency.");
    }
    if (
      startOfUtcDay(allocation.valid_from) > stayStart ||
      startOfUtcDay(allocation.valid_to) < lastMealDate
    ) {
      throw httpError(
        409,
        `Meal allocation ${allocation.name} does not cover the complete reservation stay.`
      );
    }

    assertMealAllocationFitsNightlyRate(room, allocation);

    room.meal_allocation_snapshot = snapshotMealAllocation(allocation);
  }
  return reservation;
}

function assertMealAllocationFitsNightlyRate(room, allocation) {
  const nightlyMealTotal = mealAllocationNightlyTotal({
    adultAmounts: allocation.adult_amounts,
    childAmounts: allocation.child_amounts,
    adults: room.adults,
    children: room.children
  });
  if (!room.is_complimentary && nightlyMealTotal > room.effective_nightly_rate) {
    throw httpError(
      409,
      `The nightly meal allocation (${allocation.currency} ${nightlyMealTotal.toFixed(2)}) ` +
      `cannot exceed the nightly room rate (${allocation.currency} ${Number(room.effective_nightly_rate).toFixed(2)}).`
    );
  }
}

function snapshotMealAllocation(allocation) {
  return {
    meal_allocation_id: allocation._id,
    name: allocation.name,
    meal_plan: allocation.meal_plan,
    currency: allocation.currency,
    adult_amounts: copyMealAmounts(allocation.adult_amounts),
    child_amounts: copyMealAmounts(allocation.child_amounts),
    valid_from: allocation.valid_from,
    valid_to: allocation.valid_to,
    captured_at: new Date()
  };
}

function mealAllocationNightlyTotal({ adultAmounts, childAmounts, adults, children }) {
  return money(
    sumMealAmounts(adultAmounts) * Number(adults || 0) +
    sumMealAmounts(childAmounts) * Number(children || 0)
  );
}

function mealAllocationBreakdown(room) {
  const snapshot = room.meal_allocation_snapshot;
  if (!snapshot || room.is_complimentary) return [];
  return MEALS.map((meal) => {
    const adultAmount = Number(snapshot.adult_amounts?.[meal] || 0);
    const childAmount = Number(snapshot.child_amounts?.[meal] || 0);
    const amount = money(
      adultAmount * Number(room.adults || 0) +
      childAmount * Number(room.children || 0)
    );
    return { meal, amount };
  }).filter((item) => item.amount > 0);
}

function copyMealAmounts(value) {
  return Object.fromEntries(MEALS.map((meal) => [meal, Number(value?.[meal] || 0)]));
}

function sumMealAmounts(value) {
  return MEALS.reduce((total, meal) => total + Number(value?.[meal] || 0), 0);
}

function startOfUtcDay(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  applyReservationMealAllocationSnapshots,
  mealAllocationBreakdown,
  mealAllocationNightlyTotal,
  snapshotMealAllocation
};
