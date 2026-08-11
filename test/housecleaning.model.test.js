const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const {
  HousekeepingTask,
  HousekeepingAttendant,
  HousekeepingActivity
} = require("../db_models/housecleaning.model");

function roomIds() {
  return {
    physical_room_id: new mongoose.Types.ObjectId(),
    room_type_id: new mongoose.Types.ObjectId()
  };
}

test("validates a persistent housekeeping task", async () => {
  const task = new HousekeepingTask({
    property_id: "demo",
    ...roomIds(),
    room_number: "16",
    room_type_name: "Deluxe Room",
    status: "in_progress",
    priority: "high",
    attendant: {
      attendant_id: new mongoose.Types.ObjectId(),
      employee_number: "HK-001",
      name: "Kamal"
    }
  });

  await task.validate();
  assert.equal(task.status, "in_progress");
  assert.equal(task.priority, "high");
});

test("rejects invalid housekeeping task status and priority", async () => {
  const task = new HousekeepingTask({
    property_id: "demo",
    ...roomIds(),
    room_number: "16",
    room_type_name: "Deluxe Room",
    status: "unknown",
    priority: "impossible"
  });

  await assert.rejects(task.validate(), /not a valid enum value/);
});

test("validates an attendant and rejects an invalid email", async () => {
  const attendant = new HousekeepingAttendant({
    property_id: "demo",
    employee_number: "hk-001",
    name: "Kamal Perera",
    email: "kamal@example.com"
  });
  await attendant.validate();
  assert.equal(attendant.employee_number, "HK-001");

  attendant.email = "invalid-email";
  await assert.rejects(attendant.validate(), /Email must be valid/);
});

test("validates append-only housekeeping activity actions", async () => {
  const ids = roomIds();
  const activity = new HousekeepingActivity({
    property_id: "demo",
    ...ids,
    task_id: new mongoose.Types.ObjectId(),
    room_number: "16",
    room_type_name: "Deluxe Room",
    action: "room_marked_dirty",
    from_status: "in_progress",
    to_status: "clean"
  });
  await activity.validate();
  assert.equal(activity.action, "room_marked_dirty");

  activity.action = "deleted";
  await assert.rejects(activity.validate(), /not a valid enum value/);
});
