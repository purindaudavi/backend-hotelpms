require("dotenv").config();

const assert = require("node:assert/strict");
const { app } = require("../server");
const { connectDatabase, disconnectDatabase } = require("../config/database");
const { RatePlan, DailyRate } = require("../db_models/rates.model");

const propertyId = process.env.SMOKE_PROPERTY_ID || "demo";

async function run() {
  let server;
  let ratePlanId = "";

  try {
    await connectDatabase();
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      "content-type": "application/json",
      "x-property-id": propertyId
    };

    const roomResponse = await fetch(`${baseUrl}/api/rooms?active=true`, { headers });
    await expectStatus(roomResponse, 200, "Room catalog request failed");
    const roomPayload = await roomResponse.json();
    const roomType = roomPayload.room_types?.[0];
    assert.ok(roomType?._id, `No active room type exists for property ${propertyId}.`);

    const suffix = Date.now().toString(36).toUpperCase();
    const createResponse = await fetch(`${baseUrl}/api/rates`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `Rates Smoke ${suffix}`,
        code: `SMK-${suffix}`,
        currency: roomType.currency || "LKR",
        meal_plan: "Room Only",
        valid_from: "2026-08-01",
        valid_to: "2026-08-31",
        refundable: true,
        cancellation_policy: "Smoke-test cancellation policy.",
        room_type_rates: [{
          room_type_id: roomType._id,
          amount: 10000
        }]
      })
    });
    await expectStatus(createResponse, 201, "Rate-plan creation failed");
    const created = await createResponse.json();
    ratePlanId = String(created.rate_plan._id);

    const dailyResponse = await fetch(`${baseUrl}/api/rates/${ratePlanId}/daily-rates`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        daily_rates: [{
          room_type_id: roomType._id,
          date: "2026-08-11",
          amount: 12500
        }]
      })
    });
    await expectStatus(dailyResponse, 200, "Daily-rate update failed");

    const quoteResponse = await fetch(`${baseUrl}/api/rates/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        rate_plan_id: ratePlanId,
        room_type_id: roomType._id,
        check_in: "2026-08-10",
        check_out: "2026-08-13"
      })
    });
    await expectStatus(quoteResponse, 200, "Rate quote failed");
    const quotePayload = await quoteResponse.json();
    assert.equal(quotePayload.quote.nights, 3);
    assert.equal(quotePayload.quote.total, 32500);
    assert.deepEqual(
      quotePayload.quote.nightly_rates.map((rate) => rate.amount),
      [10000, 12500, 10000]
    );

    const deleteResponse = await fetch(`${baseUrl}/api/rates/${ratePlanId}`, {
      method: "DELETE",
      headers
    });
    await expectStatus(deleteResponse, 200, "Rate-plan cleanup failed");
    ratePlanId = "";

    console.log("Live Rates API smoke test passed.");
  } finally {
    if (ratePlanId) {
      await DailyRate.deleteMany({ property_id: propertyId, rate_plan_id: ratePlanId });
      await RatePlan.deleteOne({ _id: ratePlanId, property_id: propertyId });
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDatabase();
  }
}

async function expectStatus(response, expectedStatus, label) {
  if (response.status === expectedStatus) return;
  const body = await response.text();
  assert.fail(`${label}: expected ${expectedStatus}, received ${response.status}. ${body}`);
}

run().catch((error) => {
  console.error(`Live Rates API smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
