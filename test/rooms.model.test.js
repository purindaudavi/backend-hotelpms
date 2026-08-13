const assert = require("node:assert/strict");
const test = require("node:test");
const RoomType = require("../db_models/rooms.model");

function validRoomType(overrides = {}) {
  return new RoomType({
    property_id: "demo",
    name: "Deluxe New Next",
    maximum_adults: 2,
    maximum_children: 1,
    included_adults: 2,
    included_children: 0,
    extra_adult_rate: 2000,
    extra_child_rate: 1000,
    base_rate: 6500,
    currency: "LKR",
    description: "A shared room type used by physical rooms 16 and 17.",
    amenities: ["Air Conditioner", "Fan"],
    physical_rooms: [
      {
        room_number: "16",
        floor: "1",
        operational_status: "available",
        housekeeping_status: "clean"
      },
      {
        room_number: "17",
        floor: "1",
        operational_status: "available",
        housekeeping_status: "clean"
      }
    ],
    ...overrides
  });
}

test("validates and normalizes a room type", async () => {
  const roomType = validRoomType({
    amenities: ["Air Conditioner", "Fan", "Fan"]
  });

  await roomType.validate();

  assert.equal(roomType.slug, "deluxe-new-next");
  assert.deepEqual(roomType.amenities, ["Air Conditioner", "Fan"]);
  assert.equal(roomType.physical_room_count, 2);
  assert.equal(roomType.included_adults, 2);
  assert.equal(roomType.extra_child_rate, 1000);
});

test("rejects duplicate physical room numbers inside one room type", async () => {
  const roomType = validRoomType({
    physical_rooms: [
      { room_number: "16" },
      { room_number: " 16 " }
    ]
  });

  await assert.rejects(
    roomType.validate(),
    /Physical room numbers must be unique/
  );
});

test("rejects invalid operational and housekeeping statuses", async () => {
  const roomType = validRoomType({
    physical_rooms: [
      {
        room_number: "16",
        operational_status: "reserved",
        housekeeping_status: "unknown"
      }
    ]
  });

  await assert.rejects(roomType.validate(), /not a valid enum value/);
});

test("rejects invalid capacity and negative rates", async () => {
  const roomType = validRoomType({
    maximum_adults: 0,
    maximum_children: -1,
    base_rate: -100
  });

  await assert.rejects(roomType.validate(), /less than minimum allowed value/);
});

test("rejects base-rate occupancy above room capacity", async () => {
  await assert.rejects(
    validRoomType({ included_adults: 3 }).validate(),
    /cannot exceed maximum adults/
  );
  await assert.rejects(
    validRoomType({ included_children: 2 }).validate(),
    /cannot exceed maximum children/
  );
});
