const express = require("express");
const mongoose = require("mongoose");
const ChannelConnectionRequest = require("../db_models/channel-connection-request.model");
const { notifyReviewTeam } = require("../services/channel-request-email.service");

const router = express.Router();

router.use((req, res, next) => {
  if (req.propertyRole !== "owner") {
    return res.status(403).json({ message: "Only the property owner can manage channel setup requests." });
  }
  return next();
});

router.get("/", asyncHandler(async (req, res) => {
  const requests = await ChannelConnectionRequest.find({
    property_id: req.authorizedProperty.property_id
  }).sort({ created_at: -1 }).limit(100).lean();
  res.json({ requests });
}));

router.post("/", asyncHandler(async (req, res) => {
  const input = req.body || {};
  const provider = String(input.provider || "").trim();
  const contactName = String(input.contact_name || "").trim();
  const contactEmail = String(input.contact_email || "").trim().toLowerCase();
  const providerPropertyId = String(input.provider_property_id || "").trim();
  const notes = String(input.notes || "").trim();

  if (!["Booking.com", "Agoda", "Expedia", "Custom API"].includes(provider)) {
    return res.status(400).json({ message: "Choose a supported provider." });
  }
  if (!contactName || contactName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) ||
      contactEmail.length > 254 || providerPropertyId.length > 120 || notes.length > 2000) {
    return res.status(400).json({ message: "Check the contact, provider property ID, and notes." });
  }

  const request = await ChannelConnectionRequest.create({
    property_id: req.authorizedProperty.property_id,
    provider,
    provider_property_id: providerPropertyId,
    contact_name: contactName,
    contact_email: contactEmail,
    notes,
    created_by: req.workspaceUser._id,
    history: [{ event: "submitted", actor_id: req.workspaceUser._id }]
  });
  const reviewNotification = await notifyReviewTeam(request);
  res.status(201).json({
    message: "Channel setup request submitted. No provider connection was created.",
    review_notification: reviewNotification,
    request
  });
}));

router.post("/:requestId/reply", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: "Invalid request ID." });
  }
  const note = String(req.body?.note || "").trim();
  if (note.length < 10 || note.length > 1000) {
    return res.status(400).json({ message: "Write a reply of 10 to 1,000 characters. Do not include credentials." });
  }
  const request = await ChannelConnectionRequest.findOne({
    _id: req.params.requestId,
    property_id: req.authorizedProperty.property_id
  });
  if (!request) return res.status(404).json({ message: "Channel setup request not found." });
  if (request.status !== "needs_information") {
    return res.status(409).json({ message: "The reviewer has not requested more information for this request." });
  }
  request.status = "in_review";
  request.history.push({ event: "owner_reply", actor_id: req.workspaceUser._id, note });
  await request.save();
  const reviewNotification = await notifyReviewTeam(request, "reply");
  return res.json({ request, review_notification: reviewNotification });
}));

router.post("/:requestId/cancel", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: "Invalid request ID." });
  }
  const request = await ChannelConnectionRequest.findOne({
    _id: req.params.requestId,
    property_id: req.authorizedProperty.property_id
  });
  if (!request) return res.status(404).json({ message: "Channel setup request not found." });
  if (request.status === "rejected") {
    return res.status(409).json({ message: "This request was rejected and is already closed." });
  }
  if (request.status !== "cancelled") {
    request.status = "cancelled";
    request.history.push({ event: "cancelled", actor_id: req.workspaceUser._id });
    await request.save();
  }
  return res.json({ message: "Channel setup request cancelled.", request });
}));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = router;
