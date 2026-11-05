const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const Property = require("../db_models/property.model");
const User = require("../db_models/user.model");
const Request = require("../db_models/property-deletion-request.model");
const { propertyRole } = require("../services/property-access.service");
const { withInventoryTransaction } = require("../services/inventory-transaction.service");
const { setPropertyArchived } = require("../services/property-archive.service");
const { error, requirePlatformOwner } = require("../services/property-creation.service");
const { actorFromRequest, writeAuditLog } = require("../services/booking-audit.service");

const router = express.Router();
const run = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const managerRoles = ["owner", "administrator"];
function propertyId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,99}$/.test(value)) throw error(400, "Invalid property ID.");
  return value;
}
function requestId(value) {
  if (!mongoose.isValidObjectId(value)) throw error(400, "Invalid request ID.");
  return value;
}
function text(value, min, max, label) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw error(400, `Check ${label} (${min}-${max} characters).`);
  return value.trim();
}
function checkVersion(value, actual, code = "PROPERTY_DELETION_VERSION_CONFLICT") {
  if (!Number.isInteger(value) || value < 0) throw error(400, "Refresh before making this change.");
  if (value !== (actual ?? 0)) throw error(409, "This request or property changed. Refresh and review it before trying again.", code);
}
function requireManager(property, user) {
  const role = propertyRole(property, user);
  if (!managerRoles.includes(role)) throw error(403, "Only this property's Owner or Administrator can request deletion.");
  return role;
}
const currentProperty = property => property ? { property_id: property.property_id, hotel_name: property.info.hotel_name, status: property.status, version: property.version ?? 0 } : null;
async function audit(req, record, action, description, session, changes = []) {
  return writeAuditLog({ propertyId: record.property_id, entityType: "property", entityId: record._id,
    action, description, actor: actorFromRequest(req), requestId: req.get("x-request-id") || "", session, changes });
}

// These are account-scoped routes so requesters can still read the decision
// after approval archives the hotel. No tenant/header ID grants extra access.
router.get("/", run(async (req, res) => {
  const requests = await Request.find({ requester_id: req.workspaceUser._id }).sort({ created_at: -1 }).limit(100).lean();
  res.json({ requests });
}));
router.get("/properties/:propertyId", run(async (req, res) => {
  const id = propertyId(req.params.propertyId);
  const property = await Property.findOne({ property_id: id });
  const role = requireManager(property, req.workspaceUser);
  const pending = await Request.findOne({ property_id: id, status: "pending" }).lean();
  res.json({ property: currentProperty(property), role,
    account: { name: req.workspaceUser.name, email: req.workspaceUser.email, mobile: req.workspaceUser.mobile || "" },
    pending: pending ? { request_code: pending.request_code, requested_by: pending.requested_by.name, created_at: pending.created_at } : null });
}));
router.post("/properties/:propertyId/requests", run(async (req, res) => {
  const id = propertyId(req.params.propertyId);
  const reason = text(req.body?.reason, 10, 1000, "reason");
  const phone = text(req.body?.contact_phone, 7, 30, "contact phone number");
  if (!/^[+\d\s().-]+$/.test(phone) || !/^\d{7,15}$/.test(phone.replace(/\D/g, ""))) throw error(400, "Enter a valid contact phone number.");
  // Do not bootstrap permanent inventory guard records for unauthorized IDs.
  // Authority is checked again on the fresh transactional snapshot below.
  requireManager(await Property.findOne({ property_id: id }), req.workspaceUser);
  const request = await withInventoryTransaction(id, async session => {
    const property = await Property.findOne({ property_id: id }).session(session);
    const role = requireManager(property, req.workspaceUser);
    checkVersion(req.body?.version, property.version, "PROPERTY_VERSION_CONFLICT");
    if (req.body?.confirm_name !== property.info.hotel_name) throw error(400, "Type the current property name exactly to confirm.");
    if (await Request.findOne({ property_id: id, status: "pending" }).session(session)) throw error(409, "A deletion request is already pending for this property. Refresh to see its code.");
    const recent = await Request.countDocuments({ property_id: id, created_at: { $gte: new Date(Date.now() - 86400000) } }).session(session);
    if (recent >= 5) throw error(429, "This property has reached the daily deletion request limit. Try again tomorrow.");
    const [created] = await Request.create([{
      request_code: `PDR-${crypto.randomBytes(12).toString("hex").toUpperCase()}`, property_id: id,
      property_name: property.info.hotel_name, owner_id: property.owner_id || null,
      requester_id: req.workspaceUser._id, requested_by: actorFromRequest(req), requester_role: role,
      contact_phone: phone, reason
    }], { session });
    await audit(req, property, "property_deletion_requested", `${created.request_code}: deletion requested (archive on approval). Reason: ${reason}`, session);
    return created;
  });
  res.status(201).json({ message: "Deletion request submitted. The property remains active until the PMS platform owner approves archiving.", request });
}));
router.post("/requests/:requestId/cancel", run(async (req, res) => {
  const id = requestId(req.params.requestId);
  const existing = await Request.findOne({ _id: id, requester_id: req.workspaceUser._id });
  if (!existing) throw error(404, "Request not found.");
  const request = await withInventoryTransaction(existing.property_id, async session => {
    const record = await Request.findOne({ _id: id, requester_id: req.workspaceUser._id }).session(session);
    if (!record) throw error(404, "Request not found.");
    checkVersion(req.body?.version, record.version);
    if (record.status !== "pending") throw error(409, "Only pending requests can be cancelled.");
    record.status = "cancelled"; record.cancelled_at = new Date();
    await record.save({ session });
    await audit(req, record, "property_deletion_cancelled", `${record.request_code}: requester cancelled deletion.`, session);
    return record;
  }, { allowArchivedProperty: true });
  res.json({ message: "Deletion request cancelled.", request });
}));

router.get("/review", requirePlatformOwner, run(async (req, res) => {
  const status = req.query.status || "pending";
  if (!["pending", "approved", "rejected", "cancelled", "all"].includes(status)) throw error(400, "Choose a valid request status.");
  const requests = await Request.find(status === "all" ? {} : { status }).sort({ created_at: -1 }).limit(200).lean();
  const properties = await Property.find({ property_id: { $in: requests.map(record => record.property_id) } }).select("property_id info.hotel_name status version").lean();
  const byId = new Map(properties.map(property => [property.property_id, currentProperty(property)]));
  res.json({ requests: requests.map(record => ({ ...record, current_property: byId.get(record.property_id) || null })) });
}));
router.post("/review/:requestId/decision", requirePlatformOwner, run(async (req, res) => {
  const id = requestId(req.params.requestId), decision = req.body?.decision;
  if (!["approve", "reject"].includes(decision)) throw error(400, "Choose Approve or Reject.");
  const note = text(req.body?.note, 5, 1000, "review note");
  const existing = await Request.findById(id);
  if (!existing) throw error(404, "Request not found.");
  const request = await withInventoryTransaction(existing.property_id, async session => {
    const record = await Request.findById(id).session(session);
    if (!record) throw error(404, "Request not found.");
    checkVersion(req.body?.version, record.version);
    if (record.status !== "pending") throw error(409, "This request was already reviewed or cancelled. Refresh the queue.");
    if (decision === "approve") {
      const property = await Property.findOne({ property_id: record.property_id }).session(session);
      const requester = await User.findById(record.requester_id).session(session);
      if (!property || property.status !== "active") throw error(409, "The property is no longer active. Reject this request or review the property's archive status.");
      if (!managerRoles.includes(propertyRole(property, requester)) || String(property.owner_id || "") !== String(record.owner_id || "")) {
        throw error(409, "The requester no longer has Owner/Admin authority or the property's owner changed. Reject this request and ask the current Owner/Admin to submit a new one.");
      }
      checkVersion(req.body?.property_version, property.version);
      if (req.body?.confirm_name !== property.info.hotel_name) throw error(400, "Type the current property name exactly to approve archiving.");
      const actor = actorFromRequest(req);
      // The full submission and review notes stay on the request; the property
      // has a shorter archive-summary field.
      await setPropertyArchived(property, true, actor, `${record.request_code}: ${note}`.slice(0, 1000), session);
      property.updated_by = actor;
      await property.save({ session });
      await audit(req, property, "property_platform_archived", `${record.request_code}: deletion approved; property archived. ${note}`, session, [{ field: "status", from: "active", to: "inactive" }]);
    }
    record.status = decision === "approve" ? "approved" : "rejected";
    record.review_note = note; record.reviewed_by = actorFromRequest(req); record.reviewed_at = new Date();
    await record.save({ session });
    await audit(req, record, `property_deletion_${record.status}`, `${record.request_code}: ${record.status}. ${note}`, session);
    return record;
  }, { allowArchivedProperty: true });
  res.json({ message: decision === "approve" ? "Deletion approved. The property is archived; its records are retained and Restore is available in All properties." : "Deletion request rejected. The property was not changed.", request });
}));
router.use((failure, _req, res, next) => {
  if (failure.code === 11000) return res.status(409).json({ message: "A deletion request is already pending. Refresh your requests." });
  if (failure instanceof mongoose.Error.VersionError) return res.status(409).json({ message: "This request or property changed. Refresh before trying again.", code: "PROPERTY_DELETION_VERSION_CONFLICT" });
  if (failure instanceof mongoose.Error.ValidationError) return res.status(400).json({ message: "Check the request details and try again." });
  next(failure);
});
module.exports = router;
