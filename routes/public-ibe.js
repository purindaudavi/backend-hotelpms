const express = require("express");
const { publicPropertyDetails, searchPublicRooms, createPublicBooking } = require("../services/public-ibe.service");
const { recordIbeActivity } = require("../services/ibe-api-activity.service");
const { authenticateWebsiteKey } = require("../services/ibe-website-key.service");

const router = express.Router();
const limits = new Map();
const WINDOW_MS = 60_000;
let nextPrune = 0;

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  const now = Date.now();
  if (now >= nextPrune) {
    for (const [key, entry] of limits) {
      if (now >= entry.expires) limits.delete(key);
    }
    nextPrune = now + WINDOW_MS;
  }
  const key = req.ip + ":" + req.method;
  const entry = limits.get(key);
  if ((!entry && limits.size >= 10_000) || (entry?.expires > now && entry.count >= (req.method === "POST" ? 10 : 60))) {
    return res.set("Retry-After", "60").status(429).json({ message: "Too many attempts. Try again in a minute." });
  }
  if (entry?.expires > now) entry.count++;
  else limits.set(key, { count: 1, expires: now + WINDOW_MS });
  next();
});

// Every published read and booking goes through the same credential check.
// CORS and a caller-supplied Origin are not authentication.
router.use("/:propertyId", async (req, res, next) => {
  try {
    await authenticateWebsiteKey(req);
    next();
  } catch (error) {
    if (error.statusCode === 401) {
      await recordIbeActivity(req, "request_failed", 401);
      return res.status(401).json({ message: error.message });
    }
    next(error);
  }
});

router.get("/:propertyId", async (req, res) => {
  try {
    const result = await publicPropertyDetails(req.params.propertyId);
    const fields = Object.keys(result);
    await recordIbeActivity(req, "hotel_details", 200, { data_shared: fields });
    res.json(result);
  } catch (error) {
    await recordIbeActivity(req, "request_failed", error.statusCode || 503);
    throw error;
  }
});

router.get("/:propertyId/availability", async (req, res) => {
  try {
    const result = await searchPublicRooms(req.params.propertyId, req.query);
    const fields = [...new Set(result.offers.flatMap((offer) => Object.keys(offer)))].filter((key) => key !== "offerKey");
    await recordIbeActivity(req, "availability", 200, {
      data_shared: fields, check_in: req.query.checkIn, check_out: req.query.checkOut, room_options: result.offers.length
    });
    res.json(result);
  } catch (error) {
    await recordIbeActivity(req, "request_failed", error.statusCode || 503);
    throw error;
  }
});

router.post("/:propertyId/bookings", express.json({ limit: "8kb" }), async (req, res) => {
  try {
    const result = await createPublicBooking(req.params.propertyId, req.body);
    const status = result.created ? 201 : 200;
    await recordIbeActivity(req, result.created ? "booking_created" : "booking_retrieved", status, {
      data_shared: ["booking_confirmation"], reservation_no: result.booking.reference,
      check_in: result.booking.checkIn, check_out: result.booking.checkOut
    });
    res.status(status).json(result.booking);
  } catch (error) {
    await recordIbeActivity(req, "booking_failed", error.statusCode || 503);
    throw error;
  }
});

router.use((_req, res) => res.status(404).json({ message: "Booking page unavailable." }));

router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if ([400, 403, 404, 409, 413].includes(error.statusCode)) {
    const message = error.type ? "Invalid booking request." : error.message;
    return res.status(error.statusCode).json({ message });
  }
  if (error.statusCode !== 503) console.error("Public booking request failed", error.name, error.code || "");
  return res.status(503).json({ message: "Online booking is temporarily unavailable. Please try again." });
});

module.exports = router;
