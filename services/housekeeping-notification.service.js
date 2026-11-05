const mongoose = require("mongoose");
const { HousekeepingActivity, HousekeepingTask } = require("../db_models/housecleaning.model");

const HOUSEKEEPING_NOTIFICATION_TYPES = Object.freeze(["housekeeping_request", "housekeeping_assignment"]);
function allowed(role) { return ["owner", "administrator", "housekeeping"].includes(role); }
async function activityFilter(propertyId, type, role, audience) {
  if (!allowed(role) || !HOUSEKEEPING_NOTIFICATION_TYPES.includes(type)) return null;
  const filter = { property_id: propertyId, action: type === "housekeeping_request" ? "requested" : { $in: ["assigned", "claimed"] } };
  if (role !== "housekeeping") return filter;
  if (!mongoose.isValidObjectId(audience?.attendant_id)) return null;
  if (type === "housekeeping_assignment") {
    filter["attendant.attendant_id"] = audience.attendant_id;
  } else {
    const tasks = await HousekeepingTask.find({ property_id: propertyId, status: "requested", "attendant.attendant_id": null })
      .select("_id physical_room_id requested_at").lean();
    // Tasks are reused for later cleaning cycles. A task ID alone would expose
    // old requests again; only the current cycle's event belongs in this queue.
    filter.$or = tasks.filter(task => task.requested_at).map(task => ({ task_id: task._id,
      physical_room_id: task.physical_room_id, created_at: { $gte: task.requested_at } }));
    if (!filter.$or.length) return null;
  }
  return filter;
}
function buildHousekeepingNotification(type, record, propertyId, role) {
  const claimed = record.action === "claimed";
  const request = type === "housekeeping_request";
  const actor = record.actor?.name || "Staff";
  const title = request ? `Housekeeping requested · Room ${record.room_number}`
    : claimed ? `Housekeeping request claimed · Room ${record.room_number}` : `Room ${record.room_number} assigned to ${record.attendant?.name || "an attendant"}`;
  const message = request ? `Requested by ${actor}` : claimed ? `Claimed by ${actor}` : `Assigned by ${actor}`;
  const query = new URLSearchParams({ room: record.room_number,
    ...(role === "housekeeping" ? { tab: request ? "requests" : "assigned" } : {}) });
  return { id: `${type}:${record._id}`, type, title,
    message: [message, record.room_type_name].filter(Boolean).join(" · "), reference: record.room_number,
    href: `/properties/${encodeURIComponent(propertyId)}/housekeeping/board?${query}`,
    timestamp: new Date(record.created_at).toISOString() };
}
async function listHousekeepingNotifications(propertyId, limit, role, audience) {
  if (!allowed(role)) return [];
  const batches = await Promise.all(HOUSEKEEPING_NOTIFICATION_TYPES.map(async type => {
    const filter = await activityFilter(propertyId, type, role, audience);
    if (!filter) return [];
    const records = await HousekeepingActivity.find(filter).sort({ created_at: -1 }).limit(limit)
      .select("action room_number room_type_name actor.name attendant.name created_at").lean();
    return records.map(record => buildHousekeepingNotification(type, record, propertyId, role));
  }));
  return batches.flat();
}
async function canReadHousekeepingNotification(propertyId, type, id, role, audience) {
  const filter = await activityFilter(propertyId, type, role, audience);
  return Boolean(filter && await HousekeepingActivity.findOne({ ...filter, _id: id }).select("_id").lean());
}
module.exports = { HOUSEKEEPING_NOTIFICATION_TYPES, listHousekeepingNotifications, canReadHousekeepingNotification, buildHousekeepingNotification };
