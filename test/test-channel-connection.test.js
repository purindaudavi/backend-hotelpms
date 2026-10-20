const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSnapshot, configuration } = require("../services/test-channel-connection.service");

test("maps active PMS room and rate identifiers to provider identifiers", () => {
  const snapshot = buildSnapshot("hotel-test", [{
    _id: "room-1", name: "Standard", physical_rooms: [
      { active: true, operational_status: "available" },
      { active: true, operational_status: "maintenance" }
    ]
  }], [{
    _id: "rate-1", name: "Room Only", code: "RO", meal_plan: "Room Only", currency: "LKR",
    valid_from: new Date("2026-10-01T00:00:00.000Z"), valid_to: new Date("2027-10-01T00:00:00.000Z"),
    room_type_rates: [{ room_type_id: "room-1", amount: 6500 }, { room_type_id: "other-room", amount: 7000 }]
  }]);
  assert.equal(snapshot.rooms[0].channel_room_id, "TEST-ROOM-room-1");
  assert.equal(snapshot.rooms[0].physical_room_count, 1);
  assert.equal(snapshot.rates[0].channel_rate_id, "TEST-RATE-rate-1");
  assert.equal(snapshot.rates[0].valid_from, "2026-10-01");
  assert.deepEqual(snapshot.rates[0].room_type_rates, [{ channel_room_id: "TEST-ROOM-room-1", amount: 6500 }]);
});

test("test-channel configuration is limited to the configured test hotel and loopback service", () => {
  const previous = Object.fromEntries(["NODE_ENV", "TEST_CHANNEL_PROPERTY_ID", "TEST_CHANNEL_API_KEY", "TEST_CHANNEL_URL"].map((name) => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = "development";
    process.env.TEST_CHANNEL_PROPERTY_ID = "hotel-test";
    process.env.TEST_CHANNEL_API_KEY = "0123456789abcdef";
    process.env.TEST_CHANNEL_URL = "http://127.0.0.1:3601";
    assert.equal(configuration("hotel-test").available, true);
    assert.equal(configuration("hotel-other").available, false);
    process.env.TEST_CHANNEL_URL = "http://example.com:3601";
    assert.equal(configuration("hotel-test").available, false);
    process.env.TEST_CHANNEL_URL = "http://127.0.0.1:3601";
    process.env.NODE_ENV = "production";
    assert.equal(configuration("hotel-test").available, false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
