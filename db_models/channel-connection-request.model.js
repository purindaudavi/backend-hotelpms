const mongoose = require("mongoose");

const HistoryEntrySchema = new mongoose.Schema({
  event: { type: String, enum: ["submitted", "in_review", "needs_information", "owner_reply", "mapping", "awaiting_provider_access", "rejected", "cancelled"], required: true },
  at: { type: Date, required: true, default: Date.now },
  actor_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  note: { type: String, trim: true, maxlength: 1000, default: "" }
}, { _id: false });

const ChannelConnectionRequestSchema = new mongoose.Schema({
  property_id: {
    type: String,
    required: true,
    trim: true,
    match: /^[A-Za-z0-9][A-Za-z0-9_-]{1,99}$/,
    index: true
  },
  provider: {
    type: String,
    required: true,
    enum: ["Booking.com", "Agoda", "Expedia", "Custom API"]
  },
  provider_property_id: { type: String, trim: true, maxlength: 120, default: "" },
  contact_name: { type: String, required: true, trim: true, maxlength: 120 },
  contact_email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  notes: { type: String, trim: true, maxlength: 2000, default: "" },
  status: { type: String, enum: ["submitted", "in_review", "needs_information", "mapping", "awaiting_provider_access", "rejected", "cancelled"], default: "submitted", index: true },
  history: { type: [HistoryEntrySchema], default: [] },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, {
  collection: "channel_connection_requests",
  timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
});

ChannelConnectionRequestSchema.index({ property_id: 1, created_at: -1 });

module.exports = mongoose.models.ChannelConnectionRequest ||
  mongoose.model("ChannelConnectionRequest", ChannelConnectionRequestSchema);
