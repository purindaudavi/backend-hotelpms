const mongoose = require("mongoose");
const Schema = new mongoose.Schema({
  property_id: { type: String, required: true, index: true }, request_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  request_no: String, action: String, version: Number, title: String, message: String,
  audience_ids: [{ type: mongoose.Schema.Types.ObjectId }], created_at: { type: Date, default: Date.now }
});
Schema.index({ property_id: 1, request_id: 1, action: 1, version: 1 }, { unique: true });
Schema.index({ property_id: 1, audience_ids: 1, created_at: -1 });
module.exports = mongoose.models.MoneyRequestEvent || mongoose.model("MoneyRequestEvent", Schema, "money_request_events");
