const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");
const schema = new mongoose.Schema({
  request_code: { type: String, required: true, unique: true, immutable: true },
  requester_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  account_name: { type: String, required: true, maxlength: 100 },
  account_email: { type: String, required: true, maxlength: 100 },
  contact_name: { type: String, required: true, maxlength: 100 },
  contact_phone: { type: String, required: true, maxlength: 30 },
  business_name: { type: String, required: true, maxlength: 150 },
  requested_limit: { type: Number, required: true, min: 1, max: 1000, validate: Number.isInteger },
  reason: { type: String, required: true, maxlength: 1000 },
  status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending", index: true },
  approved_limit: { type: Number, min: 0, max: 1000 },
  previous_limit: { type: Number, min: 0, max: 1000 },
  review_note: { type: String, maxlength: 1000, default: "" },
  reviewed_by: { type: ActorSchema, default: () => ({}) },
  reviewed_at: { type: Date, default: null }
}, { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, optimisticConcurrency: true, collection: "property_creation_requests" });
schema.index({ requester_id: 1 }, { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_property_request" });
schema.index({ status: 1, created_at: -1 });
module.exports = mongoose.models.PropertyCreationRequest || mongoose.model("PropertyCreationRequest", schema);
