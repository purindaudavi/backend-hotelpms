const test = require("node:test");
const assert = require("node:assert/strict");
const Property = require("../db_models/property.model");
const Settings = require("../db_models/ibe-settings.model");
const RoomType = require("../db_models/rooms.model");
const Reservation = require("../db_models/booking.model");
const { RatePlan } = require("../db_models/rates.model");
const rates = require("../services/rate-quote.service");
const inventory = require("../services/booking-availability.service");
const transactions = require("../services/inventory-transaction.service");
const Activity = require("../db_models/ibe-api-activity.model");
const WebsiteKey = require("../db_models/ibe-website-key.model");
const { SHARING_DEFAULTS } = require("../services/ibe-sharing.service");

function query(value) {
  return {
    session() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}

test("public IBE sharing is enforced on the backend and activity remains property scoped", async (t) => {
  const roomId = "507f1f77bcf86cd799439011";
  const planId = "507f1f77bcf86cd799439012";
  let sharing = { ...SHARING_DEFAULTS };
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const stay = { checkIn: today, checkOut: tomorrow, adults: 2, children: 0 };
  const settings = () => ({
    publicRatePlanId: planId, publicSharing: sharing, config: { ibeActive: true, payAtProperty: true },
    policies: { cancellationPolicy: "Private configured policy", childPolicy: "Child policy", taxPolicy: "Tax policy" },
    logoImage: "logo", ibeHomeImage: "banner", websiteOrigin: "https://hotel.example"
  });
  t.mock.method(Property, "findOne", ({ property_id }) => query(property_id === "hotel-one" ? {
    info: { hotel_name: "Example Hotel", city: "Galle", country_code: "LK", timezone: "UTC", check_in_time_from: "14:00" }
  } : null));
  t.mock.method(Settings, "findById", () => query({ settings: settings() }));
  t.mock.method(Settings, "exists", async ({ _id }) => _id === "hotel-one");
  t.mock.method(RatePlan, "findOne", (filter) => {
    assert.equal(filter.property_id, "hotel-one");
    return query({ _id: planId, room_type_rates: [{ room_type_id: roomId }] });
  });
  t.mock.method(RoomType, "findOne", ({ property_id }) => {
    assert.equal(property_id, "hotel-one");
    return query({ description: "Garden view", amenities: ["Fan"], maximum_adults: 2 });
  });
  t.mock.method(rates, "quoteRatePlan", async () => ({
    room_type_id: roomId, room_type_name: "Standard", rate_plan_id: planId,
    meal_plan: "Room Only", nights: 1, currency: "LKR", total: 6500,
    nightly_rates: [{ date: today, amount: 6500 }], refundable: true,
    cancellation_policy: "Rate plan policy"
  }));
  const checks = t.mock.method(inventory, "validateReservationInventory", async () => {});
  t.mock.method(transactions, "withInventoryTransaction", async (_property, work) => work(null));
  t.mock.method(Reservation, "findOne", () => query(null));
  const servicePath = require.resolve("../services/public-ibe.service");
  delete require.cache[servicePath];
  const { publicPropertyDetails, searchPublicRooms, createPublicBooking } = require(servicePath);
  t.after(() => delete require.cache[servicePath]);

  await t.test("published hotel data and live rates are restricted to the requested property", async () => {
    assert.equal((await publicPropertyDetails("hotel-one")).name, "Example Hotel");
    await assert.rejects(publicPropertyDetails("hotel-two"), { statusCode: 404 });
    const { offers } = await searchPublicRooms("hotel-one", stay);
    assert.equal(offers[0].total, 6500);
    assert.equal(offers[0].description, "Garden view");
  });
  await t.test("unchecked detail fields are absent from metadata and offers", async () => {
    sharing = { ...SHARING_DEFAULTS, hotelDetails: false, branding: false, stayTimes: false, policies: false, roomDetails: false };
    const hotel = await publicPropertyDetails("hotel-one");
    for (const key of ["name", "location", "logo", "banner", "checkIn", "checkOut", "childPolicy"]) {
      assert.equal(Object.hasOwn(hotel, key), false, key);
    }
    const { offers } = await searchPublicRooms("hotel-one", stay);
    for (const key of ["description", "amenities", "maximumAdults", "cancellationPolicy", "conditions", "refundable"]) {
      assert.equal(Object.hasOwn(offers[0], key), false, key);
    }
    assert.equal(offers[0].total, 6500);
  });
  await t.test("disabled searches are blocked before availability queries", async () => {
    sharing = { ...SHARING_DEFAULTS, availability: false, bookings: false };
    const before = checks.mock.calls.length;
    await assert.rejects(searchPublicRooms("hotel-one", stay), { statusCode: 403 });
    assert.equal(checks.mock.calls.length, before);
    assert.deepEqual((await publicPropertyDetails("hotel-one")).capabilities, { availability: false, bookings: false });
  });
  await t.test("a direct POST cannot bypass disabled reservations", async () => {
    sharing = { ...SHARING_DEFAULTS, bookings: false };
    await assert.rejects(createPublicBooking("hotel-one", {
      ...stay, roomTypeId: roomId, requestKey: "12345678-1234-4123-8123-123456789abc", offerKey: "0".repeat(64),
      guest: { name: "Guest Example", email: "guest@example.test", phone: "+94711112222", country: "Sri Lanka" }
    }), { statusCode: 403 });
  });
  await t.test("request activity stores the response categories without guest contact data", async () => {
    let saved;
    t.mock.method(Activity, "create", async (payload) => {
      saved = new Activity(payload);
      await saved.validate();
    });
    const { recordIbeActivity } = require("../services/ibe-api-activity.service");
    await recordIbeActivity({
      params: { propertyId: "hotel-one" }, get: () => "https://hotel.example/page",
      ibeIntegration: { id: "1".repeat(24), name: "Hotel website", website_origin: "https://hotel.example" },
      body: { guest: { email: "private@example.test" } }
    }, "booking_created", 201, { data_shared: ["booking_confirmation"], reservation_no: "RES-WEB-TEST" });
    assert.equal(saved.origin, "https://hotel.example");
    assert.equal(saved.property_id, "hotel-one");
    assert.equal(saved.reservation_no, "RES-WEB-TEST");
    assert.equal(JSON.stringify(saved).includes("private@example.test"), false);
    assert.equal(Activity.schema.indexes().find(([keys]) => keys.created_at === 1)[1].expireAfterSeconds, 2592000);
  });
  await t.test("activity reads and connection status use property and configured origin filters", async () => {
    let latestFilter, listFilter;
    t.mock.method(WebsiteKey, "findById", () => query({ key_id: "1".repeat(24), revoked_at: null }));
    t.mock.method(Activity, "findOne", (filter) => {
      latestFilter = filter;
      return query({ created_at: new Date(), origin: "https://hotel.example" });
    });
    t.mock.method(Activity, "find", (filter) => { listFilter = filter; return query([]); });
    const { listIbeActivity } = require("../services/ibe-api-activity.service");
    const result = await listIbeActivity("hotel-one");
    assert.equal(result.recent_activity, true);
    assert.equal(latestFilter.property_id, "hotel-one");
    assert.equal(latestFilter.integration_id, "1".repeat(24));
    assert.deepEqual(listFilter, { property_id: "hotel-one" });
  });
});
