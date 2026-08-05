const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const RoomType = require("../db_models/rooms.model");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const { quoteRatePlan } = require("../services/rate-quote.service");

const propertyId = "demo";
const ratePlanId = new mongoose.Types.ObjectId();
const roomTypeId = new mongoose.Types.ObjectId();

function installModelStubs({ overrides = [], planOverrides = {} } = {}) {
  const originals = {
    ratePlanFindOne: RatePlan.findOne,
    roomTypeFindOne: RoomType.findOne,
    dailyRateFind: DailyRate.find
  };

  RatePlan.findOne = async () => ({
    _id: ratePlanId,
    property_id: propertyId,
    name: "Standard B&B",
    code: "BAR-BB",
    currency: "LKR",
    meal_plan: "Bed & Breakfast",
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
    active: true
  });
  DailyRate.find = () => ({ sort: async () => overrides });

  return () => {
    RatePlan.findOne = originals.ratePlanFindOne;
    RoomType.findOne = originals.roomTypeFindOne;
    DailyRate.find = originals.dailyRateFind;
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
