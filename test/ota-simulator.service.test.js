const test = require("node:test");
const assert = require("node:assert/strict");
const Reservation = require("../db_models/booking.model");
const {
  normalizeOtaReservationInput,
  providerDisplayName
} = require("../services/ota-simulator.service");

const RATE_PLAN_ID = "64b7f01e2f7c2a0012345678";
const ROOM_TYPE_ID = "64b7f01e2f7c2a0012345679";

function validPayload() {
  return {
    property_id: "demo",
    provider: "Booking.COM",
    external_reservation_id: "BDC-TEST-1001",
    check_in: "2026-09-10",
    check_out: "2026-09-12",
    guest: {
      name: "Test OTA Guest",
      email: "TEST.GUEST@EXAMPLE.COM",
      phone: "+94 77 123 4567",
      country: "Sri Lanka"
    },
    rooms: [{
      rate_plan_id: RATE_PLAN_ID,
      room_type_id: ROOM_TYPE_ID,
      adults: 2,
      children: 0,
      quantity: 1
    }]
  };
}

test("normalizes a simulated OTA reservation", () => {
  const result = normalizeOtaReservationInput(validPayload());
  assert.equal(result.provider, "booking.com");
  assert.equal(result.guest.email, "test.guest@example.com");
  assert.equal(result.status, "confirmed");
  assert.equal(result.rooms[0].quantity, 1);
});

test("rejects a checkout that is not after check-in", () => {
  const payload = validPayload();
  payload.check_out = payload.check_in;
  assert.throws(
    () => normalizeOtaReservationInput(payload),
    /check_out must be after check_in/
  );
});

test("rejects mixed rate plans in one OTA reservation", () => {
  const payload = validPayload();
  payload.rooms.push({
    ...payload.rooms[0],
    rate_plan_id: "64b7f01e2f7c2a0012345680"
  });
  assert.throws(
    () => normalizeOtaReservationInput(payload),
    /same rate plan/
  );
});

test("uses a friendly display name for known providers", () => {
  assert.equal(providerDisplayName("booking.com"), "Booking.com");
  assert.equal(providerDisplayName("agoda"), "Agoda");
});

test("reservation schema prevents duplicate provider reservation IDs", () => {
  const index = Reservation.schema.indexes().find(([, options]) =>
    options.name === "unique_external_reservation_per_provider"
  );
  assert.ok(index);
  assert.equal(index[1].unique, true);
});
