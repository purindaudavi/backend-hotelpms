require("dotenv").config();

const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { connectDatabase, disconnectDatabase } = require("../config/database");

const apiBase = process.env.SMOKE_API_URL || "http://localhost:3500/api";
const propertyId = `codex-bookings-smoke-${Date.now()}`;
const actorHeaders = {
  "x-user-id": "codex-smoke",
  "x-user-name": "Codex Smoke Test",
  "x-user-email": "codex-smoke@example.com"
};

async function main() {
  const results = [];
  try {
    const health = await request("/health");
    assert.equal(health.status, "ok");
    results.push("health");

    const roomResponse = await request("/rooms", {
      method: "POST",
      body: {
        property_id: propertyId,
        name: "Smoke Test Double",
        maximum_adults: 2,
        maximum_children: 1,
        base_rate: 14500,
        currency: "LKR",
        description: "Temporary room type for the live Bookings API smoke test.",
        amenities: ["Air Conditioner"],
        physical_rooms: [
          {
            room_number: "SM-101",
            floor: "1",
            operational_status: "available",
            housekeeping_status: "clean"
          },
          {
            room_number: "SM-102",
            floor: "1",
            operational_status: "available",
            housekeeping_status: "clean"
          }
        ]
      }
    });
    const roomType = roomResponse.room_type;
    assert.equal(roomType.physical_rooms.length, 2);
    results.push("room_catalog");

    const reservationResponse = await request("/bookings/reservations", {
      method: "POST",
      body: {
        property_id: propertyId,
        booking_reference: "SMOKE-WEB-001",
        reservation_date: "2026-07-30",
        check_in: "2026-07-30",
        check_out: "2026-07-31",
        status: "tentative",
        booking_source: "Direct",
        booker: {
          title: "Mr",
          name: "Smoke Test Guest",
          phone: "+94710000000",
          email: "smoke-booking@example.com",
          country: "Sri Lanka"
        },
        rooms: [
          {
            room_type_id: roomType._id,
            room_type_name: roomType.name,
            physical_room_id: roomType.physical_rooms[0]._id,
            adults: 2,
            children: 0,
            currency: "LKR",
            original_nightly_rate: 14500,
            effective_nightly_rate: 14500
          }
        ],
        currency: "LKR",
        rate_plan_name: "Standard Room Only",
        meal_plan: "Room Only",
        financial_summary: {
          room_total: 14500,
          grand_total: 14500,
          paid_total: 0
        }
      }
    });
    const reservation = reservationResponse.reservation;
    assert.match(reservation.reservation_no, /^RES-/);
    results.push("reservation_create");

    await request(
      `/bookings/reservations/${reservation._id}/confirm?property_id=${propertyId}`,
      { method: "POST", body: {} }
    );
    results.push("reservation_confirm");

    const paymentResponse = await request(
      `/bookings/reservations/${reservation._id}/payments?property_id=${propertyId}`,
      {
        method: "POST",
        body: {
          amount: 5000,
          currency: "LKR",
          payment_method: "Cash",
          payment_reference: "SMOKE-PAY-001"
        }
      }
    );
    assert.equal(paymentResponse.payment.status, "posted");
    results.push("payment");

    const attachmentResponse = await request(
      `/bookings/reservations/${reservation._id}/attachments?property_id=${propertyId}`,
      {
        method: "POST",
        rawBody: Buffer.from("Smoke-test reservation attachment"),
        headers: {
          "content-type": "text/plain",
          "x-file-name": "smoke-test.txt",
          "x-document-category": "Other",
          "x-description": "Temporary attachment created by live smoke test"
        }
      }
    );
    assert.equal(attachmentResponse.attachment.file_name, "smoke-test.txt");
    results.push("attachment");

    const detail = await request(
      `/bookings/reservations/${reservation._id}?property_id=${propertyId}`
    );
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.attachments.length, 1);
    assert.ok(detail.logs.length >= 4);
    results.push("reservation_details_and_logs");

    const checkedIn = await request(
      `/bookings/reservations/${reservation._id}/check-in?property_id=${propertyId}`,
      { method: "POST", body: { business_date: "2026-07-30" } }
    );
    assert.equal(checkedIn.reservation.status, "checked_in");
    results.push("check_in");

    const checkedOut = await request(
      `/bookings/reservations/${reservation._id}/check-out?property_id=${propertyId}`,
      { method: "POST", body: {} }
    );
    assert.equal(checkedOut.reservation.status, "checked_out");
    results.push("check_out");

    const blockResponse = await request("/bookings/business-blocks", {
      method: "POST",
      body: {
        property_id: propertyId,
        block_name: "Smoke Test Crew",
        company_name: "Smoke Test Company",
        contact: {
          name: "Block Contact",
          email: "block-smoke@example.com",
          phone: "+94711111111"
        },
        check_in: "2026-08-10",
        check_out: "2026-08-12",
        cutoff_date: "2026-08-05",
        allocations: [
          {
            room_type_id: roomType._id,
            room_type_name: roomType.name,
            quantity: 2,
            currency: "LKR",
            negotiated_rate: 12000
          }
        ],
        billing: {
          payment_method: "Bank Transfer",
          billing_party: "company",
          deposit_required: 10000,
          deposit_paid: 5000
        }
      }
    });
    const block = blockResponse.business_block;
    assert.match(block.block_number, /^BB-/);
    results.push("business_block_create");

    const activated = await request(
      `/bookings/business-blocks/${block._id}/activate?property_id=${propertyId}`,
      { method: "POST", body: {} }
    );
    assert.equal(activated.business_block.status, "active");
    results.push("business_block_activate");

    const allocationId = block.allocations[0]._id;
    const pickup = await request(
      `/bookings/business-blocks/${block._id}/allocations/${allocationId}/reservations?property_id=${propertyId}`,
      {
        method: "POST",
        body: {
          quantity: 1,
          booker: {
            title: "Ms",
            name: "Block Pickup Guest",
            phone: "+94712222222",
            email: "block-pickup@example.com",
            country: "Sri Lanka"
          }
        }
      }
    );
    assert.equal(String(pickup.reservation.business_block_id), String(block._id));
    results.push("business_block_pickup");

    const blockDetail = await request(
      `/bookings/business-blocks/${block._id}?property_id=${propertyId}`
    );
    assert.equal(blockDetail.business_block.metrics.blocked, 2);
    assert.equal(blockDetail.business_block.metrics.picked, 1);
    assert.equal(blockDetail.business_block.metrics.remaining, 1);
    assert.equal(blockDetail.rooming_list.length, 1);
    assert.ok(blockDetail.logs.length >= 3);
    results.push("business_block_metrics_and_logs");

    const released = await request(
      `/bookings/business-blocks/${block._id}/release?property_id=${propertyId}`,
      { method: "POST", body: {} }
    );
    assert.equal(released.business_block.status, "released");
    assert.equal(released.business_block.metrics.remaining, 0);
    results.push("business_block_release");

    console.log(JSON.stringify({
      ok: true,
      property_id: propertyId,
      passed: results
    }, null, 2));
  } finally {
    await cleanup();
  }
}

async function request(path, options = {}) {
  const headers = {
    ...actorHeaders,
    ...(options.headers || {})
  };
  let body;
  if (options.rawBody) {
    body = options.rawBody;
  } else if (Object.prototype.hasOwnProperty.call(options, "body")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${apiBase}${path}`, {
    method: options.method || "GET",
    headers,
    body
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${path} returned ${response.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

async function cleanup() {
  await connectDatabase();
  const database = mongoose.connection.db;
  const attachmentFiles = await database
    .collection("reservation_attachments.files")
    .find({ "metadata.property_id": propertyId })
    .project({ _id: 1 })
    .toArray();
  const bucket = new mongoose.mongo.GridFSBucket(database, {
    bucketName: "reservation_attachments"
  });
  for (const file of attachmentFiles) {
    try {
      await bucket.delete(file._id);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  for (const collectionName of [
    "booking_audit_logs",
    "reservation_attachments",
    "reservation_payments",
    "reservations",
    "business_blocks",
    "guests",
    "room_types"
  ]) {
    await database.collection(collectionName).deleteMany({
      property_id: propertyId
    });
  }
  await disconnectDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
