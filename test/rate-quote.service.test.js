const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const RoomType = require("../db_models/rooms.model");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const { MealAllocation } = require("../db_models/property.model");
const { quoteRatePlan } = require("../services/rate-quote.service");

const propertyId = "demo";
const ratePlanId = new mongoose.Types.ObjectId();
const roomTypeId = new mongoose.Types.ObjectId();
const mealAllocationId = new mongoose.Types.ObjectId();

function installModelStubs({ overrides = [], planOverrides = {} } = {}) {
  const originals = {
    ratePlanFindOne: RatePlan.findOne,
    roomTypeFindOne: RoomType.findOne,
    dailyRateFind: DailyRate.find,
    mealAllocationFindOne: MealAllocation.findOne
  };

  RatePlan.findOne = async () => ({
    _id: ratePlanId,
    property_id: propertyId,
    name: "Standard B&B",
    code: "BAR-BB",
    currency: "LKR",
    meal_plan: "Bed & Breakfast",
    meal_allocation_id: mealAllocationId,
    refundable: true,
    cancellation_policy: "Free cancellation until 24 hours before check-in.",
    valid_from: new Date("2026-08-01T00:00:00.000Z"),
    valid_to: new Date("2026-08-31T00:00:00.000Z"),
    active: true,
    room_type_rates: [{ room_type_id: roomTypeId, amount: 16000 }],
    ...planOverrides
  });
  RoomType.findOne = async () => ({
    _id: roomTypeId,
    property_id: propertyId,
    name: "Deluxe Double",
    maximum_adults: 3,
    maximum_children: 1,
    included_adults: 2,
    included_children: 0,
    extra_adult_rate: 2000,
    extra_child_rate: 1000,
    base_rate: 6500,
    active: true
  });
  DailyRate.find = () => ({ sort: async () => overrides });
  MealAllocation.findOne = async () => ({
    _id: mealAllocationId,
    name: "Standard breakfast",
    meal_plan: "Bed & Breakfast",
    currency: "LKR",
    adult_amounts: { breakfast: 2000, lunch: 0, dinner: 0 },
    child_amounts: { breakfast: 1000, lunch: 0, dinner: 0 },
    valid_from: new Date("2026-08-01T00:00:00.000Z"),
    valid_to: new Date("2026-08-31T00:00:00.000Z"),
    active: true
  });

  return () => {
    RatePlan.findOne = originals.ratePlanFindOne;
    RoomType.findOne = originals.roomTypeFindOne;
    DailyRate.find = originals.dailyRateFind;
    MealAllocation.findOne = originals.mealAllocationFindOne;
  };
}

test("quotes every night and uses a daily override when present", async () => {
  const restore = installModelStubs({
    overrides: [{
      date: new Date("2026-08-02T00:00:00.000Z"),
      amount: 20000,
      stop_sell: false,
      minimum_stay: 1,
      maximum_stay: null,
      closed_to_arrival: false,
      closed_to_departure: false
    }]
  });

  try {
    const quote = await quoteRatePlan({
      propertyId,
      ratePlanId,
      roomTypeId,
      checkIn: "2026-08-01",
      checkOut: "2026-08-04"
    });
    assert.equal(quote.nights, 3);
    assert.equal(quote.total, 52000);
    assert.equal(quote.average_nightly_rate, 52000 / 3);
    assert.deepEqual(quote.nightly_rates.map((rate) => rate.amount), [16000, 20000, 16000]);
    assert.deepEqual(quote.nightly_rates.map((rate) => rate.source), ["rate_plan", "daily_rate", "rate_plan"]);
  } finally {
    restore();
  }
});

test("adds adult and child supplements above the included occupancy", async () => {
  const restore = installModelStubs();
  try {
    const quote = await quoteRatePlan({
      propertyId,
      ratePlanId,
      roomTypeId,
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      adults: 3,
      children: 1
    });
    assert.equal(quote.occupancy_pricing.extra_adults, 1);
    assert.equal(quote.occupancy_pricing.extra_children, 1);
    assert.equal(quote.occupancy_pricing.nightly_supplement, 3000);
    assert.deepEqual(quote.nightly_rates.map((rate) => rate.amount), [19000, 19000]);
    assert.equal(quote.total, 38000);
  } finally {
    restore();
  }
});

test("rejects occupancy above the room type capacity", async () => {
  const restore = installModelStubs();
  try {
    await assert.rejects(
      quoteRatePlan({
        propertyId,
        ratePlanId,
        roomTypeId,
        checkIn: "2026-08-01",
        checkOut: "2026-08-02",
        adults: 4,
        children: 0
      }),
      (error) => error.statusCode === 409 && error.code === "ADULT_CAPACITY_EXCEEDED"
    );
  } finally {
    restore();
  }
});

test("rejects a missing rate-plan price instead of using the room default rate", async () => {
  const restore = installModelStubs({
    planOverrides: { room_type_rates: [] }
  });
  try {
    await assert.rejects(
      quoteRatePlan({
        propertyId,
        ratePlanId,
        roomTypeId,
        checkIn: "2026-08-01",
        checkOut: "2026-08-02"
      }),
      (error) =>
        error.statusCode === 409 &&
        error.code === "RATE_NOT_CONFIGURED" &&
        !error.message.includes("6500")
    );
  } finally {
    restore();
  }
});

test("rejects stays outside plan validity and stop-sell dates", async () => {
  let restore = installModelStubs();
  try {
    await assert.rejects(
      quoteRatePlan({
        propertyId,
        ratePlanId,
        roomTypeId,
        checkIn: "2026-08-31",
        checkOut: "2026-09-02"
      }),
      (error) => error.statusCode === 409 && error.code === "RATE_PLAN_OUTSIDE_VALIDITY"
    );
  } finally {
    restore();
  }

  restore = installModelStubs({
    overrides: [{
      date: new Date("2026-08-02T00:00:00.000Z"),
      amount: 16000,
      stop_sell: true,
      minimum_stay: 1,
      maximum_stay: null,
      closed_to_arrival: false,
      closed_to_departure: false
    }]
  });
  try {
    await assert.rejects(
      quoteRatePlan({
        propertyId,
        ratePlanId,
        roomTypeId,
        checkIn: "2026-08-01",
        checkOut: "2026-08-04"
      }),
      (error) => error.statusCode === 409 && error.code === "RATE_STOP_SELL"
    );
  } finally {
    restore();
  }
});
