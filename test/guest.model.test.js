const assert = require("node:assert/strict");
const test = require("node:test");
const Guest = require("../db_models/guest.model");

function validGuest(overrides = {}) {
  return new Guest({
    property_id: "demo",
    name: "  Nimal   Perera  ",
    phone: "  +94 71 222 1188  ",
    country: "  Sri   Lanka  ",
    email: "  NIMAL@EXAMPLE.COM  ",
    ...overrides
  });
}

test("validates and normalizes a guest profile", async () => {
  const guest = validGuest();

  await guest.validate();

  assert.equal(guest.name, "Nimal Perera");
  assert.equal(guest.phone, "+94 71 222 1188");
  assert.equal(guest.country, "Sri Lanka");
  assert.equal(guest.email, "nimal@example.com");
});

test("requires name, phone, country and email", async () => {
  const guest = validGuest({
    name: "",
    phone: "",
    country: "",
    email: ""
  });

  await assert.rejects(
    guest.validate(),
    /Guest name is required|Guest phone number is required|Guest country is required|Guest email is required/
  );
});

test("rejects an invalid email address", async () => {
  const guest = validGuest({ email: "not-an-email" });

  await assert.rejects(
    guest.validate(),
    /Guest email address is invalid/
  );
});

test("rejects an invalid phone number", async () => {
  const guest = validGuest({ phone: "12-34" });

  await assert.rejects(
    guest.validate(),
    /must contain between 7 and 20 digits/
  );
});
