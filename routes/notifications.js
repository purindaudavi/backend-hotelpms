const express = require("express");
const NotificationReadState = require("../db_models/notification-read-state.model");
const { listPropertyNotifications } = require("../services/notification.service");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requiredPropertyId(req);
  const userId = notificationUserId(req);
  const limit = boundedLimit(req.query.limit);
  const [notifications, readState] = await Promise.all([
    listPropertyNotifications(propertyId, limit),
    NotificationReadState.findOne({ property_id: propertyId, user_id: userId }).lean()
  ]);
  const readIds = new Set(readState?.read_notification_ids || []);
  const readThrough = readState?.read_through_at
    ? new Date(readState.read_through_at).getTime()
    : 0;
  const items = notifications.map((notification) => ({
    ...notification,
    read: readIds.has(notification.id) || new Date(notification.timestamp).getTime() <= readThrough
  }));

  res.json({
    notifications: items,
    unread_count: items.filter((item) => !item.read).length
  });
}));

router.patch("/:notificationId/read", asyncHandler(async (req, res) => {
  const propertyId = requiredPropertyId(req);
  const userId = notificationUserId(req);
  const notificationId = String(req.params.notificationId || "").trim();
  if (!notificationId || notificationId.length > 200) {
    return res.status(400).json({ message: "A valid notification ID is required." });
  }

  const state = await NotificationReadState.findOneAndUpdate(
    { property_id: propertyId, user_id: userId },
    { $setOnInsert: { property_id: propertyId, user_id: userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  if (!state.read_notification_ids.includes(notificationId)) {
    state.read_notification_ids.push(notificationId);
    state.read_notification_ids = state.read_notification_ids.slice(-500);
    await state.save();
  }

  res.json({ message: "Notification marked as read." });
}));

router.post("/read-all", asyncHandler(async (req, res) => {
  const propertyId = requiredPropertyId(req);
  const userId = notificationUserId(req);
  await NotificationReadState.findOneAndUpdate(
    { property_id: propertyId, user_id: userId },
    {
      $set: {
        property_id: propertyId,
        user_id: userId,
        read_through_at: new Date(),
        read_notification_ids: []
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ message: "All notifications marked as read." });
}));

function requiredPropertyId(req) {
  const propertyId = String(req.query.property_id || req.body?.property_id || "").trim();
  if (!propertyId) {
    const error = new Error("property_id is required.");
    error.statusCode = 400;
    throw error;
  }
  return propertyId;
}

function notificationUserId(req) {
  return String(
    req.get("x-user-id") ||
    req.get("x-user-email") ||
    "anonymous"
  ).trim().toLowerCase();
}

function boundedLimit(value) {
  const limit = Number(value || 30);
  return Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 30;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = router;
