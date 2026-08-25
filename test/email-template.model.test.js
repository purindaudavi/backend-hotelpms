const test = require("node:test");
const assert = require("node:assert/strict");
const EmailTemplate = require("../db_models/email-template.model");
const {
  DEFAULT_EMAIL_TEMPLATES,
  renderCustomTemplate,
  renderText,
  serializeDefaults
} = require("../services/email-template.service");

test("email template validates and normalizes MongoDB records", async () => {
  const template = new EmailTemplate({
    property_id: " hotel-1 ",
    category: "CONFIRMATION",
    name: "  Direct   booking  ",
    subject: " Booking\nConfirmation ",
    blocks: [{ block_id: "header", kind: "header", title: "Welcome", content: "Dear {{guestName}}" }]
  });
  await template.validate();
  assert.equal(template.property_id, "hotel-1");
  assert.equal(template.category, "confirmation");
  assert.equal(template.name, "Direct booking");
  assert.equal(template.subject, "Booking Confirmation");
});

test("email template rejects an empty block collection", async () => {
  const template = new EmailTemplate({
    property_id: "hotel-1",
    category: "confirmation",
    name: "Empty",
    subject: "Empty",
    blocks: []
  });
  await assert.rejects(template.validate(), /between 1 and 30 blocks/);
});

test("built-in defaults cover every mail category and seed editable blocks", () => {
  const defaults = serializeDefaults();
  assert.equal(defaults.length, 7);
  assert.deepEqual(defaults.map((item) => item.category).sort(), Object.keys(DEFAULT_EMAIL_TEMPLATES).sort());
  assert.ok(defaults.every((item) => item.blocks.length >= 3));
});

test("custom template rendering replaces placeholders and escapes guest data", () => {
  const template = {
    category: "confirmation",
    blocks: [{ kind: "header", title: "Hello {{guestName}}", content: "Welcome to {{hotelName}}" }]
  };
  const html = renderCustomTemplate(template, { guestName: "<Guest>", hotelName: "Stay & Rest" });
  assert.match(html, /Hello &lt;Guest&gt;/);
  assert.match(html, /Stay &amp; Rest/);
  assert.equal(renderText("Reservation {{reservationNo}}", { reservationNo: "RES-1" }), "Reservation RES-1");
});
