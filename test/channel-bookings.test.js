const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const Reservation = require("../db_models/booking.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const routes = require("../routes/channel-bookings");

test("imported channel bookings use property-scoped PMS records and real history", async (t) => {
  const firstId = new mongoose.Types.ObjectId();
  const secondId = new mongoose.Types.ObjectId();
  const records = [
    {
      _id: firstId, property_id: "hotel-one", reservation_no: "RES-ONE",
      booking_reference: "DMS-TEST-1", reservation_date: new Date("2026-09-30T12:00:00Z"),
      check_in: new Date("2026-10-05T00:00:00Z"), check_out: new Date("2026-10-06T00:00:00Z"),
      status: "confirmed", booking_source: "dms-test-channel",
      external_channel: { provider: "dms-test-channel", external_reservation_id: "DMS-TEST-1", received_at: new Date("2026-09-30T12:00:00Z") },
      booker: { name: "Synthetic Guest", email: "guest@example.com" }, rooms: [{ room_type_name: "Standard", room_number: "" }],
      currency: "LKR", financial_summary: { grand_total: 6500, paid_total: 0 }
    },
    {
      _id: secondId, property_id: "hotel-two", reservation_no: "RES-TWO",
      external_channel: { provider: "agoda", external_reservation_id: "AGD-1" },
      booker: { name: "Second Guest" }, rooms: [], currency: "USD", financial_summary: { grand_total: 100, paid_total: 0 }
    }
  ];
  const matches = (filter, record) => record.property_id === filter.property_id &&
    (!filter["external_channel.provider"] || typeof filter["external_channel.provider"] !== "string" || record.external_channel.provider === filter["external_channel.provider"]);
  t.mock.method(Reservation, "find", (filter) => ({
    sort() { return this; }, skip() { return this; }, limit() { return this; },
    lean() { return Promise.resolve(records.filter((record) => matches(filter, record))); }
  }));
  t.mock.method(Reservation, "countDocuments", (filter) => Promise.resolve(records.filter((record) => matches(filter, record)).length));
  t.mock.method(Reservation, "distinct", (_field, filter) => Promise.resolve(records.filter((record) => matches(filter, record)).map((record) => record.external_channel.provider)));
  t.mock.method(Reservation, "findOne", (filter) => ({ lean() { return Promise.resolve(records.find((record) => matches(filter, record) && String(record._id) === String(filter._id)) || null); } }));
  t.mock.method(BookingAuditLog, "find", () => ({
    sort() { return this; }, select() { return this; },
    lean() { return Promise.resolve([{ _id: new mongoose.Types.ObjectId(), action: "ota_reservation_imported", description: "Test booking imported.", created_at: new Date("2026-09-30T12:00:00Z") }]); }
  }));

  const app = express();
  app.use((req, _res, next) => {
    const propertyId = req.get("x-test-property") || "hotel-one";
    req.authorizedProperty = { property_id: propertyId, info: { hotel_name: propertyId === "hotel-one" ? "Test Hotel" : "Other Hotel" } };
    next();
  });
  app.use("/channel-bookings", routes);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/channel-bookings`;

  const list = await (await fetch(base)).json();
  assert.equal(list.total, 1);
  assert.equal(list.bookings[0].unique_id, "DMS-TEST-1");
  assert.equal(list.bookings[0].property_name, "Test Hotel");
  assert.equal(list.bookings[0].currency, "LKR");
  assert.equal(list.bookings[0].total, 6500);
  assert.equal(list.bookings[0].pms_accepted, true);
  assert.equal(list.bookings[0].made_up_revision_id, undefined);
  assert.equal((await fetch(`${base}/${secondId}`)).status, 404);
  const detail = await (await fetch(`${base}/${firstId}`)).json();
  assert.equal(detail.booking.booker.name, "Synthetic Guest");
  assert.equal(detail.history[0].action, "ota_reservation_imported");
  assert.equal((await (await fetch(base, { headers: { "x-test-property": "hotel-two" } })).json()).bookings[0].unique_id, "AGD-1");
});
