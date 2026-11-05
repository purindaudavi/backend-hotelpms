const express = require("express");
const NotificationReadState = require("../db_models/notification-read-state.model");
const { listPropertyNotifications, canReadPropertyNotification, notificationTypesForRole } = require("../services/notification.service");
const { linkedAttendant } = require("../services/housekeeping-work.service");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requiredPropertyId(req);
  const userId = notificationUserId(req);
  const limit = boundedLimit(req.query.limit);
  const audience = await notificationAudience(req, propertyId);
  const [notifications, readState] = await Promise.all([
    listPropertyNotifications(propertyId, limit, req.propertyRole, audience),
    NotificationReadState.findOne({ property_id: propertyId, user_id: userId }).lean()
  ]);
  const readIds = new Set(readState?.read_notification_ids || []);
  const readThrough = readState?.read_through_at
    ? new Date(readState.read_through_at).getTime()
    : 0;
  const items = notifications.map((notification) => ({
    ...notification,
    read: readIds.has(notification.id) || new Date(notification.timestamp).getTime() <= Math.max(
      readThrough, new Date(readState?.read_through_by_type?.[notification.type] || 0).getTime()
    )
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
  const audience = await notificationAudience(req, propertyId);
  if (!await canReadPropertyNotification(propertyId, notificationId, req.propertyRole, audience)) {
    return res.status(404).json({ message: "Notification not found." });
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
  const now = new Date();
  const audience = await notificationAudience(req, propertyId);
  if (req.propertyRole === "housekeeping") {
    // Use eligible event IDs rather than a type-wide cutoff: an attendant link
    // can change later, and hidden colleagues' alerts must remain untouched.
    const eligible = await listPropertyNotifications(propertyId, 100, req.propertyRole, audience);
    const state = await NotificationReadState.findOneAndUpdate(
      { property_id: propertyId, user_id: userId },
      { $setOnInsert: { property_id: propertyId, user_id: userId } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    state.read_notification_ids = [...new Set([...state.read_notification_ids, ...eligible.map(item => item.id)])].slice(-500);
    await state.save();
    return res.json({ message: "All notifications marked as read." });
  }
  // Restricted roles never mark currently hidden categories read, even if the
  // user is later promoted. State is isolated to the property and login.
  const updates = !["owner", "administrator", "demo"].includes(req.propertyRole)
    ? Object.fromEntries(notificationTypesForRole(req.propertyRole).map((type) => [`read_through_by_type.${type}`, now]))
    : { read_through_at: now, read_notification_ids: [] };
  await NotificationReadState.findOneAndUpdate(
    { property_id: propertyId, user_id: userId },
    {
      $set: {
        property_id: propertyId,
        user_id: userId,
        ...updates
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ message: "All notifications marked as read." });
}));

async function notificationAudience(req, propertyId) {
  if (req.propertyRole !== "housekeeping") return undefined;
  const { attendant } = await linkedAttendant(req, propertyId);
  return { attendant_id: attendant._id };
}

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
