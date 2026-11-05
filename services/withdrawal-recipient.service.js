const mongoose = require("mongoose");
const Property = require("../db_models/property.model");
const User = require("../db_models/user.model");
const { propertyRole } = require("./property-access.service");

const RECIPIENT_ROLES = ["owner", "administrator"];

function eligibleRecipientRole(property, userId) {
  if (!property || property.status !== "active") return null;
  const id = String(userId || "");
  if (id && String(property.owner_id || "") === id) return "owner";
  if ((property.member_ids || []).some(value => String(value) === id) &&
      (property.administrator_ids || []).some(value => String(value) === id)) return "administrator";
  return null;
}

async function withdrawalProperty(req, session = null) {
  const propertyId = String(req.get("x-property-id") || req.body?.property_id || req.query.property_id || "");
  const property = await Property.findOne({ property_id: propertyId, status: "active" }).session(session);
  const role = propertyRole(property, req.workspaceUser);
  if (!property || ![...RECIPIENT_ROLES, "finance"].includes(role)) {
    throw requestError(403, "Only this property's Owner, Administrator or Finance staff can manage withdrawal requests.");
  }
  return { property, role };
}

async function listWithdrawalRecipients(property, session = null) {
  const ids = [property.owner_id, ...(property.administrator_ids || [])]
    .filter(id => eligibleRecipientRole(property, id));
  const users = await User.find({ _id: { $in: ids } }).select("name").session(session).lean();
  return users.map(user => ({ user_id: String(user._id), name: user.name, role: eligibleRecipientRole(property, user._id) }))
    .sort((left, right) => (left.role === right.role ? left.name.localeCompare(right.name) : left.role === "owner" ? -1 : 1));
}

async function resolveWithdrawalRecipient(property, userId, session = null) {
  if (typeof userId !== "string" || !mongoose.isValidObjectId(userId)) throw requestError(400, "Select an Owner or Administrator as the recipient.");
  const role = eligibleRecipientRole(property, userId);
  if (!role) throw requestError(400, "The recipient must be a current Owner or Administrator of this property. Refresh the recipient list.");
  const user = await User.findById(userId).select("name").session(session);
  if (!user) throw requestError(400, "The selected recipient account is unavailable. Refresh the recipient list.");
  return { user_id: user._id, name: user.name, role };
}

function requestError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
module.exports = { eligibleRecipientRole, listWithdrawalRecipients, resolveWithdrawalRecipient, withdrawalProperty };
