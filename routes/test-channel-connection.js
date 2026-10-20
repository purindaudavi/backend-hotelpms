const express = require("express");
const {
  connectionStatus,
  syncSnapshot,
  listImportedBookings
} = require("../services/test-channel-connection.service");

const router = express.Router();

router.use((req, res, next) => {
  if (process.env.NODE_ENV === "production" ||
      !process.env.TEST_CHANNEL_PROPERTY_ID ||
      req.authorizedProperty.property_id !== process.env.TEST_CHANNEL_PROPERTY_ID) {
    return res.status(404).json({ message: "Test channel is not available for this property." });
  }
  return next();
});

router.get("/connection", asyncHandler(async (req, res) => {
  res.json(await connectionStatus(req.authorizedProperty.property_id));
}));

router.post("/sync", asyncHandler(async (req, res) => {
  if (req.propertyRole !== "owner") return res.status(403).json({ message: "Only the property owner can sync the test channel." });
  const snapshot = await syncSnapshot(req.authorizedProperty.property_id);
  res.json({
    state: snapshot.state,
    last_sync: snapshot.generated_at,
    room_count: snapshot.rooms.length,
    rate_count: snapshot.rates.length,
    message: "Room and rate mappings sent to the local test channel. Date-specific availability is not synced."
  });
}));

router.get("/bookings", asyncHandler(async (req, res) => {
  const bookings = await listImportedBookings(req.authorizedProperty.property_id);
  res.json({ bookings });
}));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = router;
