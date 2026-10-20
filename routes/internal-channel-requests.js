const express = require("express");
const mongoose = require("mongoose");
const ChannelConnectionRequest = require("../db_models/channel-connection-request.model");
const { notifyHotelContact } = require("../services/channel-request-email.service");

const router = express.Router();
const REVIEW_STATUSES = new Set(["in_review", "needs_information", "mapping", "awaiting_provider_access", "rejected"]);

router.use((req, res, next) => {
  if (!["admin", "developer", "integration_reviewer"].includes(req.workspaceUser?.role)) {
    return res.status(403).json({ message: "Only an internal integration reviewer can use this queue." });
  }
  return next();
});

router.get("/", asyncHandler(async (req, res) => {
  const filter = {};
  const status = String(req.query.status || "").trim();
  if (status && status !== "all") {
    if (![...REVIEW_STATUSES, "submitted", "cancelled"].includes(status)) {
      return res.status(400).json({ message: "Invalid request status." });
    }
    filter.status = status;
  }
  const requests = await ChannelConnectionRequest.find(filter).sort({ created_at: -1 }).limit(200).lean();
  return res.json({ requests });
}));

router.patch("/:requestId/status", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: "Invalid request ID." });
  }
  const status = String(req.body?.status || "").trim();
  const note = String(req.body?.note || "").trim();
  if (!REVIEW_STATUSES.has(status)) {
    return res.status(400).json({ message: "This status cannot be set manually. A live connection cannot be activated from the review queue." });
  }
  if (note.length > 1000 || (["needs_information", "rejected"].includes(status) && note.length < 10)) {
    return res.status(400).json({ message: "Add a clear reviewer note (up to 1,000 characters)." });
  }
  const request = await ChannelConnectionRequest.findById(req.params.requestId);
  if (!request) return res.status(404).json({ message: "Channel setup request not found." });
  if (["cancelled", "rejected"].includes(request.status)) {
    return res.status(409).json({ message: "This request is closed. Submit a new request instead." });
  }
  if (request.status === status) {
    return res.status(409).json({ message: "This request already has that status." });
  }
  request.status = status;
  request.history.push({ event: status, actor_id: req.workspaceUser._id, note });
  await request.save();
  const contactNotification = await notifyHotelContact(request, note);
  return res.json({ request, contact_notification: contactNotification });
}));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = router;
