const test = require("node:test");
const assert = require("node:assert/strict");
const NotificationReadState = require("../db_models/notification-read-state.model");
const { entityHref } = require("../services/notification.service");

test("notification read state normalizes identity and bounds stored read IDs", async () => {
  const state = new NotificationReadState({
    property_id: " demo ",
    user_id: " ASIRI@EXAMPLE.COM ",
    read_notification_ids: [
      "invoice:1",
      "invoice:1",
      ...Array.from({ length: 510 }, (_, index) => `booking:${index}`)
    ]
  });

  await state.validate();

  assert.equal(state.property_id, "demo");
  assert.equal(state.user_id, "asiri@example.com");
  assert.equal(state.read_notification_ids.length, 500);
  assert.equal(new Set(state.read_notification_ids).size, 500);
});

test("notification entity links encode property and document references", () => {
  assert.equal(
    entityHref("demo hotel", "financials/invoices", "INV-2026/21"),
    "/properties/demo%20hotel/financials/invoices/INV-2026%2F21"
  );
});
