const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const schema = new mongoose.Schema({
  request_code: { type: String, required: true, unique: true, immutable: true },
  property_id: { type: String, required: true, immutable: true, index: true },
  property_name: { type: String, required: true, maxlength: 180 },
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  requester_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  requested_by: { type: ActorSchema, required: true },
  requester_role: { type: String, enum: ["owner", "administrator"], required: true },
  contact_phone: { type: String, required: true, maxlength: 30 },
  reason: { type: String, required: true, maxlength: 1000 },
  status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending", index: true },
  review_note: { type: String, maxlength: 1000, default: "" },
  reviewed_by: { type: ActorSchema, default: () => ({}) },
  reviewed_at: { type: Date, default: null },
  cancelled_at: { type: Date, default: null }
}, {
  timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  optimisticConcurrency: true, versionKey: "version", collection: "property_deletion_requests"
});
schema.index({ property_id: 1 }, { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_property_deletion" });
schema.index({ status: 1, created_at: -1 });
module.exports = mongoose.models.PropertyDeletionRequest || mongoose.model("PropertyDeletionRequest", schema);
