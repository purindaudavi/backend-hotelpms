const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Invoice = require("../db_models/invoice.model");
const {
  buildAccommodationLines,
  calculatedInvoiceStatus
} = require("../services/financial-document.service");

function validInvoice(overrides = {}) {
  return new Invoice({
    property_id: " demo ",
    invoice_no: " inv-2026-000001 ",
    reservation_id: new mongoose.Types.ObjectId(),
    reservation_no: " res-test-001 ",
    guest_id: new mongoose.Types.ObjectId(),
    billing_snapshot: {
      name: "Nimal Perera",
      email: " NIMAL@EXAMPLE.COM ",
      phone: "+94 71 222 1188",
      country: "Sri Lanka"
    },
    stay_snapshot: {
      check_in: "2026-08-10",
      check_out: "2026-08-12",
      nights: 2,
      room_numbers: ["16"]
    },
    invoice_date: "2026-08-06",
    due_date: "2026-08-10",
    currency: "lkr",
    line_items: [
      {
        source_type: "accommodation",
        service_date: "2026-08-10",
        description: "Deluxe Room - 2 nights",
        room_number: "16",
        quantity: 2,
        unit_price: 6500,
        discount_amount: 1000,
        tax_rate: 10
      },
      {
        source_type: "meal",
        service_date: "2026-08-10",
        description: "Dinner",
        quantity: 2,
        unit_price: 1000
      }
    ],
    ...overrides
  });
}

test("validates, normalizes, and calculates invoice totals", async () => {
  const invoice = validInvoice();
  await invoice.validate();

  assert.equal(invoice.property_id, "demo");
  assert.equal(invoice.invoice_no, "INV-2026-000001");
  assert.equal(invoice.reservation_no, "RES-TEST-001");
  assert.equal(invoice.currency, "LKR");
  assert.equal(invoice.billing_snapshot.email, "nimal@example.com");
  assert.equal(invoice.subtotal, 15000);
  assert.equal(invoice.discount_total, 1000);
  assert.equal(invoice.tax_total, 1200);
  assert.equal(invoice.grand_total, 15200);
  assert.equal(invoice.balance_due, 15200);
  assert.equal(invoice.line_items[0].total_amount, 13200);
});

test("rejects an invoice without billable lines", async () => {
  await assert.rejects(
    validInvoice({ line_items: [] }).validate(),
    /At least one invoice line is required/
  );
});

test("rejects an excessive line discount and an invalid due date", async () => {
  const excessiveDiscount = validInvoice({
    line_items: [{
      source_type: "service",
      service_date: "2026-08-10",
      description: "Airport transfer",
      quantity: 1,
      unit_price: 1000,
      discount_amount: 1001
    }]
  });
  await assert.rejects(excessiveDiscount.validate(), /discount cannot exceed/i);

  await assert.rejects(
    validInvoice({ due_date: "2026-08-05" }).validate(),
    /due date cannot be before/i
  );
});

test("builds accommodation lines from the reservation's saved room rates", () => {
  const roomLineId = new mongoose.Types.ObjectId();
  const lines = buildAccommodationLines({
    check_in: new Date("2026-08-10T00:00:00.000Z"),
    check_out: new Date("2026-08-13T00:00:00.000Z"),
    is_day_room: false,
    rooms: [{
      _id: roomLineId,
      room_type_name: "Deluxe Double",
      room_number: "16",
      effective_nightly_rate: 6500,
      is_complimentary: false
    }]
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].source_id, String(roomLineId));
  assert.equal(lines[0].quantity, 3);
  assert.equal(lines[0].unit_price, 6500);
  assert.match(lines[0].description, /3 nights/);
});

test("calculates readable invoice payment statuses", () => {
  assert.equal(calculatedInvoiceStatus({ grand_total: 1000, paid_amount: 0, credited_amount: 0 }), "issued");
  assert.equal(calculatedInvoiceStatus({ grand_total: 1000, paid_amount: 400, credited_amount: 0 }), "partially_paid");
  assert.equal(calculatedInvoiceStatus({ grand_total: 1000, paid_amount: 1000, credited_amount: 0 }), "paid");
  assert.equal(calculatedInvoiceStatus({ grand_total: 1000, paid_amount: 0, credited_amount: 1000 }), "credited");
});
