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
      check_in_time_from: "14:00",
      check_out_time_from: "11:00",
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
    check_in_time_from: "25:00",
    check_in_time_to: "12:60",
    check_out_time_from: "5:00",
    check_out_time_to: "08:00 AM"
  });

  await assert.rejects(property.validate(), (error) => {
    assert.ok(error.errors["info.country_code"]);
    assert.ok(error.errors["info.home_currency"]);
    assert.ok(error.errors["info.email"]);
    assert.ok(error.errors["info.website"]);
    assert.ok(error.errors["info.check_in_time_from"]);
    assert.ok(error.errors["info.check_in_time_to"]);
    assert.ok(error.errors["info.check_out_time_from"]);
    assert.ok(error.errors["info.check_out_time_to"]);
    return true;
  });
});


test("stay time ranges provide defaults and allow crossing midnight", async () => {
  const property = validProperty();
  assert.equal(property.info.check_in_time_from, "14:00");
  assert.equal(property.info.check_in_time_to, "23:59");
  assert.equal(property.info.check_out_time_from, "11:00");
  assert.equal(property.info.check_out_time_to, "12:00");
  property.info.check_in_time_from = "18:00";
  property.info.check_in_time_to = "12:00";
  property.info.check_out_time_from = "05:00";
  property.info.check_out_time_to = "08:00";
  await property.validate();
  property.info.check_out_time_from = "23:00";
  property.info.check_out_time_to = "01:00";
  await property.validate();
});

test("stored single times populate From fields without replacing saved ranges", async () => {
  const raw = validProperty().toObject();
  delete raw.info.check_in_time_from;
  delete raw.info.check_out_time_from;
  delete raw.info.check_in_time_to;
  delete raw.info.check_out_time_to;
  raw.info.check_in_time = "16:30";
  raw.info.check_out_time = "10:15";
  const property = Property.hydrate({ ...raw, info: { ...raw.info } });
  assert.equal(property.info.check_in_time_from, "16:30");
  assert.equal(property.info.check_out_time_from, "10:15");
  assert.equal(property.info.check_in_time_to, "23:59");
  assert.equal(property.info.check_out_time_to, "12:00");
  await property.validate();

  raw.info.check_in_time_from = "18:00";
  raw.info.check_out_time_from = "05:00";
  const ranged = Property.hydrate(raw);
  assert.equal(ranged.info.check_in_time_from, "18:00");
  assert.equal(ranged.info.check_out_time_from, "05:00");
});


test("saving a legacy property persists all four range fields and removes old single times", async t => {
  const raw = validProperty().toObject();
  raw.version = 7;
  for (const field of ["check_in_time_from", "check_in_time_to", "check_out_time_from", "check_out_time_to"]) {
    delete raw.info[field];
  }
  raw.info.check_in_time = "16:30";
  raw.info.check_out_time = "10:15";
  const property = Property.hydrate(raw);
  let savedUpdate;
  t.mock.method(Property.collection, "updateOne", async (filter, update) => {
    assert.equal(String(filter._id), String(property._id));
    assert.equal(filter.version, 7, "migration retains optimistic concurrency checks");
    savedUpdate = update;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });

  // Save without changing the time inputs, as with Settings -> Edit -> Save.
  await property.save();
  assert.equal(savedUpdate.$set["info.check_in_time_from"], "16:30");
  assert.equal(savedUpdate.$set["info.check_in_time_to"], "23:59");
  assert.equal(savedUpdate.$set["info.check_out_time_from"], "10:15");
  assert.equal(savedUpdate.$set["info.check_out_time_to"], "12:00");
  assert.equal(savedUpdate.$unset["info.check_in_time"], 1);
  assert.equal(savedUpdate.$unset["info.check_out_time"], 1);
  assert.equal(savedUpdate.$inc.version, 1);
  assert.equal(Object.hasOwn(property.info.toObject(), "check_in_time"), false);
  assert.equal(Object.hasOwn(property.info.toObject(), "check_out_time"), false);
});

test("legacy cleanup retains explicit saved ranges and leaves modern properties unmodified", () => {
  const raw = validProperty({
    check_in_time_from: "18:00", check_in_time_to: "12:00",
    check_out_time_from: "05:00", check_out_time_to: "08:00"
  }).toObject();
  const modern = Property.hydrate({ ...raw, info: { ...raw.info } });
  assert.equal(modern.isModified("info.check_in_time_from"), false);
  assert.equal(modern.$getChanges().$unset, undefined);

  raw.info.check_in_time = "14:00";
  raw.info.check_out_time = "11:00";
  const property = Property.hydrate(raw);
  const changes = property.$getChanges();
  assert.equal(changes.$set["info.check_in_time_from"], "18:00");
  assert.equal(changes.$set["info.check_in_time_to"], "12:00");
  assert.equal(changes.$set["info.check_out_time_from"], "05:00");
  assert.equal(changes.$set["info.check_out_time_to"], "08:00");
  assert.equal(changes.$unset["info.check_in_time"], 1);
  assert.equal(changes.$unset["info.check_out_time"], 1);
});

test("every stay time range endpoint is required", async () => {
  for (const field of ["check_in_time_from", "check_in_time_to", "check_out_time_from", "check_out_time_to"]) {
    const property = validProperty({ [field]: "" });
    await assert.rejects(property.validate(), error => {
      assert.ok(error.errors["info." + field]);
      return true;
    });
  }
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

test("provides valid default property appearance colors", async () => {
  const property = validProperty();
  await property.validate();

  assert.equal(property.theme.accent_color, "#3b82f6");
  assert.equal(property.theme.reservation_status_colors.confirmed, "#10b981");
  assert.equal(property.theme.reservation_status_colors.checked_in, "#06b6d4");
});

test("rejects property appearance colors outside #RRGGBB format", async () => {
  const property = validProperty();
  property.theme = {
    accent_color: "blue",
    reservation_status_colors: { confirmed: "#123" }
  };

  await assert.rejects(property.validate(), (error) => {
    assert.ok(error.errors["theme.accent_color"]);
    assert.ok(error.errors["theme.reservation_status_colors.confirmed"]);
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
