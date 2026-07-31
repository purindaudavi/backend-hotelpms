const assert = require("node:assert/strict");
const test = require("node:test");
const CreateEvent = require("../db_models/create-event.model");

function validEvent(overrides = {}) {
  return new CreateEvent({
    property_id: "demo",
    title: "  Crew   briefing  ",
    venue: "  Meeting   Room  ",
    event_date: "2026-08-03",
    start_time: "09:00",
    end_time: "10:30",
    owner: "  Asiri   Perera  ",
    status: "confirmed",
    ...overrides
  });
}

test("validates and normalizes an event booking", async () => {
  const event = validEvent();

  await event.validate();

  assert.equal(event.title, "Crew briefing");
  assert.equal(event.venue, "Meeting Room");
  assert.equal(event.venue_key, "meeting room");
  assert.equal(event.owner, "Asiri Perera");
  assert.equal(event.event_date.toISOString(), "2026-08-03T00:00:00.000Z");
});

test("requires the calendar fields", async () => {
  const event = validEvent({
    title: "",
    venue: "",
    event_date: null,
    start_time: "",
    end_time: "",
    owner: ""
  });

  await assert.rejects(
    event.validate(),
    /Event title is required|Venue is required|Event date is required|Start time is required|End time is required|Event owner is required/
  );
});

test("rejects an end time that is not after the start time", async () => {
  const event = validEvent({
    start_time: "10:30",
    end_time: "10:00"
  });

  await assert.rejects(
    event.validate(),
    /End time must be later than start time/
  );
});

test("rejects invalid time and status values", async () => {
  const event = validEvent({
    start_time: "9:00",
    status: "cancelled"
  });

  await assert.rejects(
    event.validate(),
    /Start time must use HH:mm format|Status must be confirmed, tentative, or blocked/
  );
});
