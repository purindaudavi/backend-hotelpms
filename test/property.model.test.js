const assert = require("node:assert/strict");
const test = require("node:test");
const Property = require("../db_models/property.model");
const { PropertyImage, MealAllocation } = require("../db_models/property.model");

function validProperty(overrides = {}) {
  return new Property({
    property_id: " demo ",
    info: {
      hotel_name: "  Ronaka   Airport Transit Hotel ",
      pms_name: "  Ronaka   PMS ",
      hotel_type: " Hotel ",
      star_category: 3,
      address: "No. 09, Airport Junction, Seeduwa",
      city: " Katunayake ",
      postal_code: "11450",
      country_code: "lk",
      phone: "+94 70 355 1340",
      email: " HOTEL@EXAMPLE.COM ",
      website: "https://example.com",
      check_in_time: "14:00",
      check_out_time: "11:00",
      home_currency: "lkr",
      language_code: "en",
      timezone: "Asia/Colombo",
      latitude: 7.154879,
      longitude: 79.871947,
      ...overrides
    }
  });
}

test("validates and normalizes property information", async () => {
  const property = validProperty();
  await property.validate();

  assert.equal(property.property_id, "demo");
  assert.equal(property.info.hotel_name, "Ronaka Airport Transit Hotel");
  assert.equal(property.info.pms_name, "Ronaka PMS");
  assert.equal(property.info.city, "Katunayake");
  assert.equal(property.info.country_code, "LK");
  assert.equal(property.info.email, "hotel@example.com");
  assert.equal(property.info.home_currency, "LKR");
  assert.equal(property.info.language_code, "EN");
  assert.match(property.info.hotel_guid, /^[0-9a-f-]{36}$/);
});

test("rejects invalid country, currency, email, website and times", async () => {
  const property = validProperty({
    country_code: "Sri Lanka",
    home_currency: "rupees",
    email: "invalid-email",
    website: "ftp://example.com",
    check_in_time: "25:00"
  });

  await assert.rejects(property.validate(), (error) => {
    assert.ok(error.errors["info.country_code"]);
    assert.ok(error.errors["info.home_currency"]);
    assert.ok(error.errors["info.email"]);
    assert.ok(error.errors["info.website"]);
    assert.ok(error.errors["info.check_in_time"]);
    return true;
  });
});

test("rejects coordinates and star categories outside their valid ranges", async () => {
  const property = validProperty({
    star_category: 6,
    latitude: 91,
    longitude: -181
  });

  await assert.rejects(property.validate(), (error) => {
    assert.ok(error.errors["info.star_category"]);
    assert.ok(error.errors["info.latitude"]);
    assert.ok(error.errors["info.longitude"]);
    return true;
  });
});

test("requires the core property identity and contact fields", async () => {
  const property = new Property({
    property_id: "demo",
    info: { hotel_name: "", address: "", country_code: "", email: "" }
  });

  await assert.rejects(property.validate(), /required/i);
});

test("validates property logo and gallery image metadata", async () => {
  const image = new PropertyImage({
    property_id: "demo",
    file_id: "64a000000000000000000001",
    image_type: "logo",
    filename: "hotel-logo.png",
    content_type: "image/png",
    size: 2048,
    alt_text: "Ronaka Airport Transit Hotel logo",
    is_primary: true
  });

  await image.validate();
  assert.equal(image.image_type, "logo");
  assert.equal(image.sort_order, 0);
});

test("rejects unsupported property image metadata", async () => {
  const image = new PropertyImage({
    property_id: "demo",
    file_id: "64a000000000000000000002",
    image_type: "banner",
    filename: "hotel.gif",
    content_type: "image/gif",
    size: 0
  });

  await assert.rejects(image.validate(), (error) => {
    assert.ok(error.errors.image_type);
    assert.ok(error.errors.content_type);
    assert.ok(error.errors.size);
    return true;
  });
});

test("validates and normalizes effective-dated meal allocations", async () => {
  const allocation = new MealAllocation({
    property_id: " demo ",
    name: " Standard   B&B Allocation ",
    meal_plan: "Bed & Breakfast",
    currency: "lkr",
    adult_amounts: { breakfast: 2000, lunch: 0, dinner: 0 },
    child_amounts: { breakfast: 1000, lunch: 0, dinner: 0 },
    valid_from: "2026-08-01",
    valid_to: "2027-07-31"
  });

  await allocation.validate();
  assert.equal(allocation.property_id, "demo");
  assert.equal(allocation.name, "Standard B&B Allocation");
  assert.equal(allocation.currency, "LKR");
  assert.equal(allocation.valid_from.toISOString(), "2026-08-01T00:00:00.000Z");
});

test("rejects meals outside the selected plan and reversed validity dates", async () => {
  const allocation = new MealAllocation({
    property_id: "demo",
    name: "Invalid B&B",
    meal_plan: "Bed & Breakfast",
    currency: "LKR",
    adult_amounts: { breakfast: 2000, lunch: 500, dinner: 0 },
    valid_from: "2026-08-10",
    valid_to: "2026-08-01"
  });

  await assert.rejects(allocation.validate(), (error) => {
    assert.ok(error.errors["adult_amounts.lunch"]);
    assert.ok(error.errors.valid_to);
    return true;
  });
});
