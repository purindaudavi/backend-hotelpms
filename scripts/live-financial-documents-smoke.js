require("dotenv").config();

const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { app } = require("../server");
const { connectDatabase, disconnectDatabase } = require("../config/database");
const Reservation = require("../db_models/booking.model");
const Guest = require("../db_models/guest.model");
const Invoice = require("../db_models/invoice.model");
const CreditNote = require("../db_models/credit-note.model");
const Refund = require("../db_models/refund.model");
const DocumentCounter = require("../db_models/document-counter.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const BookingAuditLog = require("../db_models/booking-log.model");

const suffix = Date.now().toString(36).toLowerCase();
const propertyId = `__financial_smoke_${suffix}`;
let server;
let guest;
let reservation;

async function run() {
  try {
    await connectDatabase();
    await createFixtures();
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      "content-type": "application/json",
      "x-property-id": propertyId,
      "x-user-id": "smoke-test",
      "x-user-name": "Financial Smoke Test"
    };

    const createdInvoice = await requestJson(`${baseUrl}/api/invoices`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reservation_id: reservation._id })
    }, 201);
    const invoiceId = createdInvoice.invoice._id;
    const invoiceLineId = createdInvoice.invoice.line_items[0]._id;
    assert.match(createdInvoice.invoice.invoice_no, /^INV-\d{4}-\d{6}$/);
    assert.equal(createdInvoice.invoice.grand_total, 13000);
    assert.equal(createdInvoice.invoice.status, "draft");

    const issuedInvoice = await requestJson(`${baseUrl}/api/invoices/${invoiceId}/issue`, {
      method: "POST",
      headers,
      body: "{}"
    }, 200);
    assert.equal(issuedInvoice.invoice.status, "issued");

    const postedPayment = await requestJson(`${baseUrl}/api/invoices/${invoiceId}/payments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        amount: 13000,
        payment_method: "cash",
        payment_reference: `SMOKE-${suffix}`
      })
    }, 201);
    assert.equal(postedPayment.invoice.status, "paid");
    assert.equal(postedPayment.invoice.balance_due, 0);

    const createdCredit = await requestJson(`${baseUrl}/api/credits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        invoice_id: invoiceId,
        reason_code: "rate_correction",
        reason: "Automated smoke-test rate correction.",
        line_items: [{
          invoice_line_id: invoiceLineId,
          category: "accommodation",
          description: "Smoke-test room-rate correction",
          quantity: 2,
          unit_amount: 500,
          tax_amount: 0
        }]
      })
    }, 201);
    assert.match(createdCredit.credit.credit_note_no, /^CN-\d{4}-\d{6}$/);

    const issuedCredit = await requestJson(
      `${baseUrl}/api/credits/${createdCredit.credit._id}/issue`,
      { method: "POST", headers, body: "{}" },
      200
    );
    assert.equal(issuedCredit.invoice.credited_amount, 1000);
    assert.equal(issuedCredit.invoice.balance_due, 0);
    assert.equal(issuedCredit.invoice.refund_due, 1000);

    const createdRefund = await requestJson(`${baseUrl}/api/refunds`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        invoice_id: invoiceId,
        payment_id: postedPayment.payment._id,
        amount: 1000,
        refund_method: "cash",
        reference_number: `REFUND-${suffix}`,
        reason: "Returning the credit-note overpayment."
      })
    }, 201);
    assert.match(createdRefund.refund.refund_no, /^RF-\d{4}-\d{6}$/);
    assert.equal(createdRefund.refund.status, "pending");

    const completedRefund = await requestJson(
      `${baseUrl}/api/refunds/${createdRefund.refund._id}/complete`,
      { method: "POST", headers, body: "{}" },
      200
    );
    assert.equal(completedRefund.refund.status, "completed");
    assert.equal(completedRefund.invoice.paid_amount, 12000);
    assert.equal(completedRefund.invoice.refund_due, 0);
    assert.equal(completedRefund.invoice.balance_due, 0);

    const invoiceDetail = await requestJson(
      `${baseUrl}/api/invoices/${invoiceId}`,
      { headers },
      200
    );
    assert.equal(invoiceDetail.payments.length, 1);
    assert.equal(invoiceDetail.credits.length, 1);
    assert.equal(invoiceDetail.refunds.length, 1);
    assert.ok(invoiceDetail.logs.length >= 6);

    console.log("Live invoice, credit-note, and refund API smoke test passed.");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState === 1) await cleanup();
    await disconnectDatabase();
  }
}

async function createFixtures() {
  guest = await Guest.create({
    property_id: propertyId,
    name: "Financial Smoke Guest",
    phone: "+94 71 000 0000",
    country: "Sri Lanka",
    email: `financial-smoke-${suffix}@example.com`
  });
  reservation = await Reservation.create({
    property_id: propertyId,
    reservation_no: `RES-${suffix}`,
    reservation_date: "2026-08-06",
    check_in: "2026-08-10",
    check_out: "2026-08-12",
    status: "confirmed",
    booking_source: "Direct",
    booker: {
      guest_profile_id: guest._id,
      name: guest.name,
      phone: guest.phone,
      email: guest.email,
      country: guest.country
    },
    rooms: [{
      room_type_id: new mongoose.Types.ObjectId(),
      room_type_name: "Financial Smoke Room",
      room_number: "S-01",
      adults: 2,
      children: 0,
      currency: "LKR",
      original_nightly_rate: 6500,
      effective_nightly_rate: 6500
    }],
    currency: "LKR",
    financial_summary: { room_total: 13000, grand_total: 13000 }
  });
}

async function cleanup() {
  const invoices = await Invoice.find({ property_id: propertyId }).select("_id");
  const credits = await CreditNote.find({ property_id: propertyId }).select("_id");
  const refunds = await Refund.find({ property_id: propertyId }).select("_id");
  const entityIds = [
    ...(reservation ? [reservation._id] : []),
    ...invoices.map((item) => item._id),
    ...credits.map((item) => item._id),
    ...refunds.map((item) => item._id)
  ];
  await Promise.all([
    ReservationPayment.deleteMany({ property_id: propertyId }),
    BookingAuditLog.deleteMany({ property_id: propertyId, entity_id: { $in: entityIds } }),
    Refund.deleteMany({ property_id: propertyId }),
    CreditNote.deleteMany({ property_id: propertyId }),
    Invoice.deleteMany({ property_id: propertyId }),
    DocumentCounter.deleteMany({ property_id: propertyId }),
    Reservation.deleteMany({ property_id: propertyId }),
    Guest.deleteMany({ property_id: propertyId })
  ]);
}

async function requestJson(url, options, expectedStatus) {
  const response = await fetch(url, options);
  const body = await response.text();
  if (response.status !== expectedStatus) {
    assert.fail(`Expected ${expectedStatus}, received ${response.status}: ${body}`);
  }
  return JSON.parse(body);
}

run().catch((error) => {
  console.error(`Live financial documents API smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
