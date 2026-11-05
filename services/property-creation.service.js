const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../db_models/user.model");
const Property = require("../db_models/property.model");

function error(statusCode, message, code) { return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) }); }
function totalLimit(value, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum || value > 1000) throw error(400, `Enter a whole-number total property limit from ${minimum} to 1,000.`);
  return value;
}
async function transaction(work) {
  const session = await mongoose.startSession();
  try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; }
  finally { await session.endSession(); }
}
// Every approval and property creation writes the same account document before
// counting properties. Concurrent final-slot attempts serialize on this guard.
async function lockAccount(userId, session) {
  const account = await User.findOneAndUpdate({ _id: userId }, { $inc: { property_creation_revision: 1 } }, { returnDocument: "after", session });
  if (!account) throw error(404, "Account not found.");
  return account;
}
async function ownedCount(userId, session = null) {
  // Inactive properties still consume their owner's allowance. Memberships do not.
  return Property.countDocuments({ owner_id: userId }).session(session);
}
async function creationAccess(account, session = null) {
  const owned = await ownedCount(account._id, session);
  const limit = Number.isInteger(account.property_creation_limit) ? account.property_creation_limit : 0;
  return { approved_limit: limit, owned_count: owned, remaining: Math.max(limit - owned, 0), can_create: owned < limit,
    can_review: account.platform_owner === true };
}
async function requireCreationSlot(userId, session) {
  const account = await lockAccount(userId, session);
  const access = await creationAccess(account, session);
  if (access.approved_limit < 1) throw error(403, "PMS platform-owner approval is required before you can create a property. Submit a property access request.", "PROPERTY_CREATION_APPROVAL_REQUIRED");
  if (!access.can_create) throw error(409, "You have reached your approved property limit. Request a higher total limit before creating another property.", "PROPERTY_CREATION_LIMIT_REACHED");
  return access;
}
function requirePlatformOwner(req, res, next) {
  if (req.workspaceUser?.platform_owner !== true) return res.status(403).json({ message: "Only an authorized PMS platform owner can review property access requests." });
  next();
}
function requestCode() { return `PCR-${crypto.randomBytes(12).toString("hex").toUpperCase()}`; }
module.exports = { error, totalLimit, transaction, lockAccount, ownedCount, creationAccess, requireCreationSlot, requirePlatformOwner, requestCode };
