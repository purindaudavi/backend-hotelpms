const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const IbeSettings = require("../db_models/ibe-settings.model");
const Property = require("../db_models/property.model");
const User = require("../db_models/user.model");
const { RatePlan } = require("../db_models/rates.model");

const setup = {
  websiteOrigin: "",
  publicSharing: { hotelDetails: true, branding: true, stayTimes: true, policies: true, roomDetails: true, availability: true, bookings: true },
  publicRatePlanId: "",
  config: {
    headerColour: "#224466", ibeActive: false, allowPay50: false, payAtProperty: true,
    allowPayLater: false, payLaterDays: 0, childFriendly: false, childAgeMin: 0, childAgeMax: 0
  },
  policies: { cancellationPolicy: "Cancel up to two days before arrival.", childPolicy: "", taxPolicy: "" },
  minStayRules: { "507f1f77bcf86cd799439011::2026-11-25": 2 },
  packages: [], promoCodes: [],
  smartPricing: {
    enabled: false, baseAdjustmentPercent: 0, weekendAdjustmentPercent: 10,
    highOccupancyThreshold: 80, highOccupancyAdjustmentPercent: 15, lowOccupancyThreshold: 35,
    lowOccupancyDiscountPercent: 10, minRateGuard: 0, maxRateGuard: 0
  },
  ibeHomeImage: "", logoImage: "", logoWidth: 400, logoHeight: 200,
  bannerOffsetX: 0, bannerOffsetY: 0, bannerScale: 1
};

test("IBE settings are property scoped, validated, and saved with version checks", async (t) => {
  process.env.JWT_SECRET = "test-secret-ibe-settings";
  const users = ["Owner", "Administrator", "Member", "Other"].map((name) => ({
    _id: new mongoose.Types.ObjectId(), name, email: name + "@example.test", role: "user"
  }));
  const [owner, admin, member, other] = users;
  const hotels = new Map([
    ["hotel-one", { property_id: "hotel-one", status: "active", owner_id: owner._id,
      member_ids: [admin._id, member._id], staff_roles: [{ user_id: admin._id, role: "administrator" }] }],
    ["hotel-two", { property_id: "hotel-two", status: "active", owner_id: other._id, member_ids: [] }]
  ]);
  t.mock.method(User, "findById", (id) => ({ select: async () => users.find((user) => String(user._id) === id) }));
  t.mock.method(Property, "findOne", async ({ property_id }) => hotels.get(property_id));

  const records = new Map();
  t.mock.method(IbeSettings, "findById", (id) => ({ lean: async () => records.get(id) }));
  t.mock.method(IbeSettings, "create", async (input) => {
    if (records.has(input._id)) throw Object.assign(new Error("Duplicate"), { code: 11000 });
    const record = new IbeSettings(input);
    await record.validate();
    if (records.has(input._id)) throw Object.assign(new Error("Duplicate"), { code: 11000 });
    records.set(input._id, record.toObject());
    return record;
  });
  t.mock.method(IbeSettings, "findOneAndUpdate", (filter, update) => ({
    lean: async () => {
      const record = records.get(filter._id);
      if (record?.version !== filter.version) return null;
      const updated = { ...record, settings: update.$set.settings, version: record.version + update.$inc.version };
      records.set(filter._id, updated);
      return updated;
    }
  }));

  const { app } = require("../app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (actor, { property = "hotel-one", method = "GET", body } = {}) => fetch(
    `http://127.0.0.1:${server.address().port}/api/properties/${property}/ibe-settings`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(actor && { Authorization: "Bearer " + jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET) })
      },
      ...(body && { body: JSON.stringify(body) })
    }
  );

  assert.equal((await request(null)).status, 401);
  assert.equal((await request(member)).status, 403);
  assert.equal((await request(member, { method: "PUT", body: { version: 0, settings: setup } })).status, 403);
  assert.equal((await request(admin, { property: "hotel-two" })).status, 403);
  assert.deepEqual(await (await request(owner)).json(), { version: 0, settings: null });
  const invalidSettings = { ...setup, config: { ...setup.config, childAgeMin: 12, childAgeMax: 5 } };
  assert.equal((await request(owner, { method: "PUT", body: { version: 0, settings: invalidSettings } })).status, 400);
  assert.equal(records.size, 0);
  for (const settings of [
    { ...setup, websiteOrigin: "javascript:alert(1)" },
    { ...setup, publicSharing: { ...setup.publicSharing, availability: false, bookings: true } },
    { ...setup, publicSharing: { hotelDetails: "false" } }
  ]) {
    assert.equal((await request(owner, { method: "PUT", body: { version: 0, settings } })).status, 400);
  }

  const firstSave = { method: "PUT", body: { version: 0, settings: { ...setup, activeTab: "IBE Config", hotel: { hotelName: "Untrusted" } } } };
  const firstResults = await Promise.all([request(owner, firstSave), request(admin, firstSave)]);
  assert.deepEqual(firstResults.map((response) => response.status).sort(), [200, 409]);
  assert.deepEqual(await (await request(admin)).json(), { version: 1, settings: setup });
  assert.deepEqual(await (await request(other, { property: "hotel-two" })).json(), { version: 0, settings: null });

  const nextSetup = { ...setup, minStayRules: {}, config: { ...setup.config, ibeActive: true } };
  const update = { method: "PUT", body: { version: 1, settings: nextSetup } };
  assert.deepEqual(await (await request(admin, update)).json(), { version: 2, settings: nextSetup });
  const stale = await request(owner, { method: "PUT", body: { version: 1, settings: setup } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "IBE_SETTINGS_CONFLICT");
  assert.deepEqual(await (await request(owner)).json(), { version: 2, settings: nextSetup });

  const publicRatePlanId = String(new mongoose.Types.ObjectId());
  const publish = { ...nextSetup, publicRatePlanId };
  const planLookup = t.mock.method(RatePlan, "exists", async (filter) => filter.property_id === "hotel-one");
  assert.equal((await request(owner, { method: "PUT", body: { version: 2, settings: {
    ...publish, config: { ...publish.config, payAtProperty: false }
  } } })).status, 400);
  assert.equal((await request(other, { property: "hotel-two", method: "PUT", body: { version: 0, settings: publish } })).status, 400);
  assert.deepEqual(await (await request(owner, { method: "PUT", body: { version: 2, settings: publish } })).json(), { version: 3, settings: publish });
  assert.deepEqual(planLookup.mock.calls.map((call) => call.arguments[0]), ["hotel-two", "hotel-one"].map((property_id) => ({
    _id: publicRatePlanId, property_id, active: true, meal_plan: "Room Only"
  })));
});
