const express = require("express");
const mongoose = require("mongoose");
const User = require("../db_models/user.model");
const Request = require("../db_models/property-creation-request.model");
const { actorFromRequest } = require("../services/booking-audit.service");
const { error, totalLimit, transaction, lockAccount, ownedCount, creationAccess, requirePlatformOwner, requestCode } = require("../services/property-creation.service");
const router = express.Router();
const run = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
function text(value, min, max, label) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw error(400, `Check ${label} (${min}–${max} characters).`);
  return value.trim();
}
function id(value) { if (!mongoose.isValidObjectId(value)) throw error(400, "Invalid request ID."); return value; }

router.get("/", run(async (req, res) => {
  const [access, requests] = await Promise.all([creationAccess(req.workspaceUser), Request.find({ requester_id: req.workspaceUser._id }).sort({ created_at: -1 }).limit(50).lean()]);
  res.json({ ...access, account: { name: req.workspaceUser.name, email: req.workspaceUser.email, mobile: req.workspaceUser.mobile }, requests });
}));
router.post("/requests", run(async (req, res) => {
  const input = req.body || {};
  const contact_name = text(input.contact_name, 2, 100, "contact name");
  const contact_phone = text(input.contact_phone, 7, 30, "phone number");
  if (!/^[+\d\s().-]+$/.test(contact_phone) || !/^\d{7,15}$/.test(contact_phone.replace(/\D/g, ""))) throw error(400, "Enter a valid contact phone number.");
  const business_name = text(input.business_name, 2, 150, "business name");
  const reason = text(input.reason, 10, 1000, "request reason");
  const requested_limit = totalLimit(input.requested_limit, 1);
  const request = await transaction(async session => {
    const account = await lockAccount(req.workspaceUser._id, session);
    if (await Request.findOne({ requester_id: account._id, status: "pending" }).session(session)) throw error(409, "You already have a pending request. Track its request code or cancel it before submitting another.");
    const recent = await Request.countDocuments({ requester_id: account._id, created_at: { $gte: new Date(Date.now() - 86400000) } }).session(session);
    if (recent >= 5) throw error(429, "You have reached the daily request limit. Try again tomorrow.");
    const [created] = await Request.create([{ request_code: requestCode(), requester_id: account._id, account_name: account.name, account_email: account.email,
      contact_name, contact_phone, business_name, requested_limit, reason }], { session });
    return created;
  });
  res.status(201).json({ message: "Request submitted. Property creation remains restricted until approval.", request });
}));
router.post("/requests/:requestId/cancel", run(async (req, res) => {
  const requestId = id(req.params.requestId);
  const request = await transaction(async session => {
    await lockAccount(req.workspaceUser._id, session);
    const record = await Request.findOne({ _id: requestId, requester_id: req.workspaceUser._id }).session(session);
    if (!record) throw error(404, "Request not found.");
    if (record.status !== "pending") throw error(409, "Only pending requests can be cancelled.");
    record.status = "cancelled"; await record.save({ session }); return record;
  });
  res.json({ request });
}));

router.get("/review", requirePlatformOwner, run(async (req, res) => {
  const status = req.query.status || "pending";
  if (!["pending", "approved", "rejected", "cancelled", "all"].includes(status)) throw error(400, "Choose a valid request status.");
  const requests = await Request.find(status === "all" ? {} : { status }).sort({ created_at: -1 }).limit(200).lean();
  const accounts = await User.find({ _id: { $in: [...new Set(requests.map(record => String(record.requester_id)))] } }).select("name email property_creation_limit").lean();
  const quotas = await Promise.all(accounts.map(async account => ({ id: String(account._id), ...await creationAccess(account) })));
  const byId = new Map(quotas.map(account => [account.id, account]));
  res.json({ requests: requests.map(record => ({ ...record, access: byId.get(String(record.requester_id)) || null })) });
}));
router.post("/review/:requestId/decision", requirePlatformOwner, run(async (req, res) => {
  const requestId = id(req.params.requestId);
  const decision = req.body?.decision;
  if (!["approve", "reject"].includes(decision)) throw error(400, "Choose Approve or Reject.");
  const note = text(req.body?.note || "", decision === "reject" ? 5 : 0, 1000, "review note");
  const limit = decision === "approve" ? totalLimit(req.body?.approved_limit, 1) : null;
  const request = await transaction(async session => {
    const existing = await Request.findById(requestId).session(session);
    if (!existing) throw error(404, "Request not found.");
    const account = await lockAccount(existing.requester_id, session);
    const record = await Request.findById(requestId).session(session);
    if (record.status !== "pending") throw error(409, "This request was already reviewed or cancelled. Refresh the queue.");
    if (decision === "approve") {
      const count = await ownedCount(account._id, session);
      if (limit < count) throw error(409, `This account already owns ${count} properties. Approve a total limit of at least ${count}.`);
      record.previous_limit = account.property_creation_limit || 0;
      record.approved_limit = limit;
      await User.updateOne({ _id: account._id }, { $set: { property_creation_limit: limit } }, { session });
    }
    record.status = decision === "approve" ? "approved" : "rejected";
    record.review_note = note; record.reviewed_by = actorFromRequest(req); record.reviewed_at = new Date();
    await record.save({ session }); return record;
  });
  res.json({ message: decision === "approve" ? "Approved total property limit saved." : "Request rejected.", request });
}));
router.use((failure, _req, res, next) => {
  if (failure.code === 11000) return res.status(409).json({ message: "A request is already pending. Refresh your request list." });
  if (failure instanceof mongoose.Error.VersionError) return res.status(409).json({ message: "This request changed. Refresh and try again." });
  next(failure);
});
module.exports = router;
