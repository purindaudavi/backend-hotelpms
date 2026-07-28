const express = require("express");
const mongoose = require("mongoose");
const Guest = require("../db_models/guest.model");

const router = express.Router();
const GUEST_FIELDS = ["name", "phone", "country", "email"];

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = getPropertyId(req);
  if (!propertyId) {
    return res.status(400).json({
      message: "property_id is required as a query parameter or x-property-id header."
    });
  }

  const query = { property_id: propertyId };
  const search = String(req.query.search || "").trim();
  const country = String(req.query.country || "").trim();
  const email = String(req.query.email || "").trim().toLowerCase();

  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    query.$or = [
      { name: pattern },
      { phone: pattern },
      { country: pattern },
      { email: pattern }
    ];
  }
  if (country && country.toLowerCase() !== "all") {
    query.country = new RegExp(`^${escapeRegExp(country)}$`, "i");
  }
  if (email && email !== "all") {
    query.email = new RegExp(escapeRegExp(email), "i");
  }

  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const skip = (page - 1) * limit;

  const [guests, total] = await Promise.all([
    Guest.find(query)
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(limit),
    Guest.countDocuments(query)
  ]);

  return res.status(200).json({
    count: guests.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    guests
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = getPropertyId(req);
  if (!propertyId) {
    return res.status(400).json({
      message: "property_id is required in the request body or x-property-id header."
    });
  }

  const guest = new Guest({ property_id: propertyId });
  applyGuestPayload(guest, req.body || {});
  await guest.save();

  return res.status(201).json({
    message: "Guest profile created successfully.",
    guest
  });
}));

router.get("/:guestId", asyncHandler(async (req, res) => {
  const guest = await findGuest(req);
  if (!guest) {
    return res.status(404).json({ message: "Guest profile not found." });
  }

  return res.status(200).json({ guest });
}));

router.get("/findbymail/:email", asyncHandler(async (req, res) => {
  const query = { email: req.params.email };
  const guest = await Guest.findOne(query);
  if (!guest) {
    return res.status(404).json({ message: "Guest profile not found." });
  }
  return res.status(200).json({ guest });
}));

router.patch("/:guestId", asyncHandler(async (req, res) => {
  
  const guest = await findGuest(req);
  if (!guest) {
    return res.status(404).json({ message: "Guest profile not found." });
  }

  applyGuestPayload(guest, req.body || {});
  await guest.save();

  return res.status(200).json({
    message: "Guest profile updated successfully.",
    guest
  });
}));

router.delete("/:guestId", asyncHandler(async (req, res) => {
  const guest = await findGuest(req);
  if (!guest) {
    return res.status(404).json({ message: "Guest profile not found." });
  }

  await guest.deleteOne();
  return res.status(200).json({
    message: "Guest profile deleted successfully."
  });
}));

router.use((error, _req, res, _next) => {
  if (error.code === 11000) {
    return res.status(409).json({
      message: "A guest profile with this email already exists for this property."
    });
  }
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError
  ) {
    return res.status(400).json({
      message: "Guest profile validation failed.",
      errors: Object.values(error.errors || {}).map(
        (validationError) => validationError.message
      )
    });
  }
  if (error instanceof mongoose.Error.VersionError) {
    return res.status(409).json({
      message: "This guest profile was changed by another request. Reload it and try again."
    });
  }

  console.error(error);
  return res.status(500).json({
    message: "The guest profile request could not be completed."
  });
});

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getPropertyId(req) {
  return String(
    req.query.property_id ||
    req.get("x-property-id") ||
    req.body?.property_id ||
    ""
  ).trim();
}

async function findGuest(req) {
  if (!mongoose.isValidObjectId(req.params.guestId)) return null;
  const query = { _id: req.params.guestId };
  const propertyId = getPropertyId(req);
  if (propertyId) query.property_id = propertyId;
  return Guest.findOne(query);
}

function applyGuestPayload(guest, payload) {
  GUEST_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      guest[field] = payload[field];
    }
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = router;
