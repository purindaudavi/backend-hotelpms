const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");
const Schema = new mongoose.Schema({
  property_id: { type: String, required: true, immutable: true },
  currency: { type: String, required: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
  amount: { type: Number, required: true, min: 0, immutable: true },
  note: { type: String, required: true, trim: true, minlength: 5, maxlength: 1000, immutable: true },
  created_by: { type: ActorSchema, required: true, immutable: true },
  created_at: { type: Date, default: Date.now, immutable: true }
}, { versionKey: false });
Schema.index({ property_id: 1, currency: 1 }, { unique: true });
module.exports = mongoose.models.FundsOpening || mongoose.model("FundsOpening", Schema, "funds_openings");
