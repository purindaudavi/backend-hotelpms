const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { RatePlan, DailyRate } = require("../db_models/rates.model");
const {
  parseDateOnly,
  enumerateStayDates,
  dateKey
} = require("../services/rate-quote.service");

const roomTypeId = new mongoose.Types.ObjectId();

function validRatePlan(overrides = {}) {
  return new RatePlan({
    property_id: " demo ",
    name: " Standard   B&B ",
    code: " bar-bb ",
    currency: "lkr",
    meal_plan: "Bed & Breakfast",
    valid_from: "2026-08-01",
    valid_to: "2027-07-31",
    refundable: true,
    cancellation_policy: "Free cancellation until 24 hours before check-in.",
    room_type_rates: [{ room_type_id: roomTypeId, amount: 16000 }],
    ...overrides
  });
}

test("validates and normalizes a rate plan", async () => {
  const plan = validRatePlan();
  await plan.validate();

  assert.equal(plan.property_id, "demo");
  assert.equal(plan.name, "Standard B&B");
  assert.equal(plan.slug, "standard-b-b");
  assert.equal(plan.code, "BAR-BB");
  assert.equal(plan.currency, "LKR");
  assert.equal(plan.room_type_rates[0].amount, 16000);
});

test("rejects an invalid validity period and duplicate room type prices", async () => {
  await assert.rejects(
    validRatePlan({ valid_from: "2026-08-10", valid_to: "2026-08-01" }).validate(),
    /cannot be before/
  );

  await assert.rejects(
    validRatePlan({
      room_type_rates: [
        { room_type_id: roomTypeId, amount: 15000 },
        { room_type_id: roomTypeId, amount: 16000 }
      ]
    }).validate(),
    /only once/
  );
});

test("rejects missing room-type prices and negative amounts", async () => {
  await assert.rejects(validRatePlan({ room_type_rates: [] }).validate(), /At least one/);
  await assert.rejects(
    validRatePlan({ room_type_rates: [{ room_type_id: roomTypeId, amount: -1 }] }).validate(),
    /cannot be negative/
  );
});

test("normalizes daily rates and validates stay restrictions", async () => {
  const dailyRate = new DailyRate({
    property_id: " demo ",
    rate_plan_id: new mongoose.Types.ObjectId(),
    room_type_id: roomTypeId,
    date: "2026-08-02T18:30:00.000Z",
    amount: 17500,
    minimum_stay: 2,
    maximum_stay: 5
  });
  await dailyRate.validate();

  assert.equal(dailyRate.property_id, "demo");
  assert.equal(dailyRate.date.toISOString(), "2026-08-02T00:00:00.000Z");

  dailyRate.maximum_stay = 1;
  await assert.rejects(dailyRate.validate(), /cannot be less than/);
});

test("date helpers enforce date-only input and checkout-exclusive stay nights", () => {
  const checkIn = parseDateOnly("2026-08-01", "check_in");
  const checkOut = parseDateOnly("2026-08-04", "check_out");
  assert.deepEqual(
    enumerateStayDates(checkIn, checkOut).map(dateKey),
    ["2026-08-01", "2026-08-02", "2026-08-03"]
  );
  assert.throws(() => parseDateOnly("08/01/2026"), /YYYY-MM-DD/);
  assert.throws(() => parseDateOnly("2026-02-30"), /valid calendar date/);
});
