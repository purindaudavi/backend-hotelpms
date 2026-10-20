const assert = require("node:assert/strict");
const test = require("node:test");
const Reservation = require("../db_models/booking.model");
const { DAY_MS, inventoryRange, overlapsInventoryDates, reservationOverlapDateQuery } = require("../services/booking-inventory-dates.service");

const stay = (from, to, day = false) => ({ check_in: new Date(from), check_out: new Date(to), is_day_room: day });

test("day-use inventory spans one calendar day without changing saved dates or zero nights", () => {
  const record = new Reservation(stay("2026-10-20", "2026-10-20", true));
  const checkIn = record.check_in.getTime();
  const checkOut = record.check_out.getTime();
  const { start, end } = inventoryRange(record);
  assert.equal(end - start, DAY_MS);
  assert.equal(record.nights, 0);
  assert.equal(record.check_in.getTime(), checkIn);
  assert.equal(record.check_out.getTime(), checkOut);
});

test("normal overnight checkout remains exclusive", () => {
  const overnight = stay("2026-10-19", "2026-10-20");
  const dayUse = stay("2026-10-20", "2026-10-20", true);
  assert.equal(overlapsInventoryDates(overnight, dayUse), false);
  assert.equal(overlapsInventoryDates(dayUse, overnight), false);
});

test("day-use conflicts with an overnight arrival in either comparison direction", () => {
  const overnight = stay("2026-10-20", "2026-10-22");
  const dayUse = stay("2026-10-20", "2026-10-20", true);
  assert.equal(overlapsInventoryDates(overnight, dayUse), true);
  assert.equal(overlapsInventoryDates(dayUse, overnight), true);
});

test("day-use arrivals on adjacent days do not overlap across a year boundary", () => {
  assert.equal(overlapsInventoryDates(stay("2026-12-31", "2026-12-31", true), stay("2027-01-01", "2027-01-01", true)), false);
});

test("the query includes same-day records even when their checkout equals the requested start", () => {
  const query = reservationOverlapDateQuery(new Date("2026-10-20"), new Date("2026-10-20"));
  assert.equal(query.check_in.$lt.toISOString(), "2026-10-21T00:00:00.000Z");
  assert.equal(query.$or[1].is_day_room, true);
  assert.equal(query.$or[1].check_in.$gte.toISOString(), "2026-10-20T00:00:00.000Z");
});

test("invalid availability dates fail closed with a helpful validation message", () => {
  assert.throws(() => inventoryRange(stay("invalid", "2026-10-20")), { statusCode: 400, message: /check the reservation dates/ });
});
