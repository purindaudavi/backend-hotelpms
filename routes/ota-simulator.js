const express = require("express");
const {
  createSimulatedOtaReservation,
  findSimulatedOtaReservation
} = require("../services/ota-simulator.service");

const router = express.Router();

router.use((req, res, next) => {
  if (!simulatorEnabled()) {
    return res.status(404).json({
      message: "The simulated OTA API is disabled."
    });
  }

  const configuredKey = String(process.env.OTA_SIMULATOR_API_KEY || "").trim();
  if (configuredKey && req.get("x-ota-api-key") !== configuredKey) {
    return res.status(401).json({ message: "Invalid or missing OTA simulator API key." });
  }
  return next();
});

router.get("/health", (_req, res) => {
  return res.status(200).json({
    status: "ok",
    service: "ota-simulator",
    mode: "test-only"
  });
});

router.post("/reservations", asyncHandler(async (req, res) => {
  const result = await createSimulatedOtaReservation(req.body, {
    requestId: String(req.get("x-request-id") || "").trim()
  });

  return res.status(result.created ? 201 : 200).json({
    message: result.created
      ? "Simulated OTA reservation imported successfully."
      : "This OTA reservation was already imported; the existing reservation was returned.",
    duplicate: !result.created,
    reservation: result.reservation,
    invoice: result.invoice
  });
}));

router.get("/reservations/:provider/:externalReservationId", asyncHandler(async (req, res) => {
  const reservation = await findSimulatedOtaReservation({
    propertyId: req.query.property_id,
    provider: req.params.provider,
    externalReservationId: req.params.externalReservationId
  });

  if (!reservation) {
    return res.status(404).json({ message: "Simulated OTA reservation not found." });
  }
  return res.status(200).json({ reservation });
}));

function simulatorEnabled() {
  const configured = String(process.env.OTA_SIMULATOR_ENABLED || "").trim().toLowerCase();
  if (configured) return ["1", "true", "yes", "on"].includes(configured);
  return process.env.NODE_ENV !== "production";
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = router;
