const assert = require("node:assert/strict");
const test = require("node:test");
const { buildDashboardSummary } = require("../services/dashboard.service");

function room(id, number, operationalStatus = "available") {
  return { _id: id, room_number: number, active: true, operational_status: operationalStatus, housekeeping_status: "clean" };
}

function reservation(overrides = {}) {
  return {
    status: "confirmed",
    currency: "LKR",
    check_in: new Date("2026-08-04T00:00:00.000Z"),
    check_out: new Date("2026-08-06T00:00:00.000Z"),
    is_day_room: false,
    booking_source: "Direct",
    booker: { country: "Sri Lanka" },
    travel_agent: { name: "" },
    rooms: [{ physical_room_id: "room-1", adults: 2, children: 1 }],
    financial_summary: { room_total: 10000, grand_total: 12000, tax_total: 2000, extra_total: 0, discount_total: 0 },
    ...overrides
  };
}

test("builds live dashboard metrics from reservations and rooms", () => {
  const summary = buildDashboardSummary({
    propertyId: "demo",
    asOf: "2026-08-04",
    currency: "LKR",
    roomTypes: [{ currency: "LKR", physical_rooms: [room("room-1", "101", "occupied"), room("room-2", "102")] }],
    reservations: [reservation()]
  });

  assert.equal(summary.overview.arrivals, 1);
  assert.equal(summary.overview.arrival_guests, 3);
  assert.equal(summary.overview.occupied_rooms, 1);
  assert.equal(summary.overview.occupancy, 50);
  assert.equal(summary.overview.revenue, 12000);
  assert.equal(summary.booking_sources[0].label, "Direct");
  assert.equal(summary.booking_sources[0].room_nights, 2);
  assert.equal(summary.countries[0].label, "Sri Lanka");
});

test("separates cancelled and no-show reservations from occupied room nights", () => {
  const summary = buildDashboardSummary({
    asOf: "2026-08-04",
    roomTypes: [{ currency: "LKR", physical_rooms: [room("room-1", "101")] }],
    reservations: [
      reservation({ status: "cancelled" }),
      reservation({ status: "no_show", rooms: [{ physical_room_id: "room-2", adults: 1, children: 0 }] })
    ]
  });
  const august = summary.monthly_room_nights.at(-1);
  assert.equal(august.room_nights, 0);
  assert.equal(august.cancelled, 1);
  assert.equal(august.no_show, 1);
  assert.equal(summary.overview.revenue, 0);
});

test("rejects invalid dashboard dates and currencies", () => {
  assert.throws(() => buildDashboardSummary({ asOf: "08/04/2026" }), /YYYY-MM-DD/);
  assert.throws(() => buildDashboardSummary({ asOf: "2026-08-04", currency: "rupees" }), /three-letter/);
  assert.throws(() => buildDashboardSummary({ asOf: "2026-08-04", dateFrom: "2026-08-10" }), /provided together/);
  assert.throws(() => buildDashboardSummary({ asOf: "2026-08-04", dateFrom: "2026-08-10", dateTo: "2026-08-01" }), /on or after/);
});

test("counts operational room statuses and excludes inactive rooms", () => {
  const summary = buildDashboardSummary({ asOf: "2026-08-04", roomTypes: [{ physical_rooms: [
    room("1", "101"), room("2", "102", "occupied"), room("3", "103", "out_of_order"),
    room("4", "104", "maintenance"), { ...room("5", "105"), active: false }
  ] }] });
  assert.deepEqual(summary.room_statuses, [
    { status: "available", count: 1 }, { status: "occupied", count: 1 },
    { status: "out_of_order", count: 1 }, { status: "maintenance", count: 1 }
  ]);
  assert.equal(summary.overview.total_rooms, 4);
});

test("uses the selected dashboard range for trends, sources, and countries", () => {
  const summary = buildDashboardSummary({
    asOf: "2026-08-04",
    dateFrom: "2026-08-05",
    dateTo: "2026-08-06",
    roomTypes: [{ currency: "LKR", physical_rooms: [room("room-1", "101")] }],
    reservations: [
      reservation(),
      reservation({
        check_in: new Date("2026-08-08T00:00:00.000Z"),
        check_out: new Date("2026-08-10T00:00:00.000Z"),
        booking_source: "Agoda",
        booker: { country: "India" }
      })
    ]
  });

  assert.deepEqual(summary.period, { date_from: "2026-08-05", date_to: "2026-08-06" });
  assert.equal(summary.occupancy_trend.length, 2);
  assert.deepEqual(summary.booking_sources, [{ label: "Direct", room_nights: 1 }]);
  assert.deepEqual(summary.countries, [{ label: "Sri Lanka", room_nights: 1 }]);
  assert.deepEqual(summary.monthly_room_nights, [{ month: "2026-08", room_nights: 1, cancelled: 0, no_show: 0 }]);
});
