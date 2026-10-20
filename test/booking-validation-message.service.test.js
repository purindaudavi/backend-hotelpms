const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const InventoryGuard = require("../db_models/inventory-guard.model");
const Reservation = require("../db_models/booking.model");
const { RatePlan } = require("../db_models/rates.model");
const { MealAllocation } = require("../db_models/property.model");
const { bookingValidationMessage } = require("../services/booking-validation-message.service");

test("invalid guest data gives a short field-specific message, not an overlap claim", async () => {
  const reservation = new Reservation({
    property_id: "message-test", reservation_no: "TEST-1", check_in: "2026-10-20", check_out: "2026-10-22",
    booker: { name: "Test Guest", phone: "+94710000000", email: "invalid", country: "Sri Lanka" },
    rooms: [{ room_type_id: new mongoose.Types.ObjectId(), room_type_name: "Standard", adults: 1 }]
  });
  await assert.rejects(reservation.validate(), (error) => {
    assert.equal(bookingValidationMessage(error), "Please check the guest email address and try again.");
    return true;
  });
});

test("a mismatched guest-to-room reference asks the user to reopen the form", () => {
  const error = { errors: { occupants: { path: "occupants", message: "Occupant Example references a reservation room that does not exist." } } };
  assert.equal(bookingValidationMessage(error), "Room and guest selections do not match. Reopen the reservation, check the details and try again.");
});

test("an invalid room ID asks for reselection without exposing a raw cast error", () => {
  const error = new mongoose.Error.CastError("ObjectId", "old-room-id", "rooms.0.room_type_id");
  assert.equal(bookingValidationMessage(error), "Please reselect the room and rate plan, then try again.");
});

test("invalid dates get date guidance", () => {
  const error = new mongoose.Error.CastError("Date", "invalid-date", "check_out");
  assert.equal(bookingValidationMessage(error), "Please check the reservation dates and try again.");
});

test("unknown validation reasons use a helpful neutral fallback", () => {
  assert.equal(bookingValidationMessage({}), "Please check the reservation details and try again.");
});

test("the booking endpoint returns the actionable validation message used by the PMS", async (t) => {
  const emptyQuery = () => {
    const query = Promise.resolve([]);
    query.session = () => query;
    return query;
  };
  t.mock.method(RatePlan, "find", emptyQuery);
  t.mock.method(MealAllocation, "find", emptyQuery);
  t.mock.method(InventoryGuard, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(mongoose, "startSession", async () => ({
    withTransaction: async (work) => work(), endSession: async () => {}
  }));
  const app = express();
  app.use(express.json());
  app.use("/bookings", require("../routes/bookings"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/bookings/reservations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      property_id: "message-test", status: "tentative", check_in: "2026-10-20", check_out: "2026-10-22",
      booker: { name: "Test Guest", phone: "+94710000000", email: "invalid", country: "Sri Lanka" },
      rooms: [{ room_type_id: new mongoose.Types.ObjectId(), room_type_name: "Standard", adults: 1 }]
    })
  });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.message, "Please check the guest email address and try again.");
  assert.ok(result.errors.some((message) => /email/i.test(message)));
});
