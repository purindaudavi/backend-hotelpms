const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");
const ReceiptSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 150 },
  content_type: { type: String, enum: ["image/jpeg", "image/png", "application/pdf"], required: true },
  size: { type: Number, required: true, max: 3 * 1024 * 1024 },
  data: { type: Buffer, select: false },
  uploaded_by: ActorSchema, uploaded_at: { type: Date, default: Date.now }
});
const Schema = new mongoose.Schema({
  property_id: { type: String, required: true, index: true },
  request_no: { type: String, required: true },
  requester_id: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true, index: true },
  requester: { type: ActorSchema, required: true, immutable: true },
  requester_role: { type: String, required: true, immutable: true },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true, uppercase: true, match: /^[A-Z]{3}$/ },
  purpose: { type: String, required: true, trim: true, minlength: 5, maxlength: 1000 },
  kind: { type: String, enum: ["advance", "expense"], default: "advance" },
  status: { type: String, enum: ["pending", "approved", "paid", "rejected", "cancelled"], default: "pending", index: true },
  approved_by: ActorSchema, approved_at: Date,
  paid_by: ActorSchema, paid_at: Date,
  payment_method: { type: String, enum: ["cash", "bank_transfer", "cheque", "other"] },
  payment_method_details: { type: String, trim: true, maxlength: 150 },
  payment_reference: { type: String, trim: true, maxlength: 150 },
  payment_note: { type: String, trim: true, maxlength: 1000 },
  settled_at: Date, settled_by: ActorSchema, actual_spent: Number, returned_amount: Number,
  settlement_note: { type: String, trim: true, maxlength: 1000 },
  expense_id: mongoose.Schema.Types.ObjectId,
  receipts: { type: [ReceiptSchema], default: [], validate: v => v.length <= 3 },
  history: [{ action: String, actor: ActorSchema, note: String, at: { type: Date, default: Date.now } }]
}, { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, optimisticConcurrency: true });
Schema.index({ property_id: 1, request_no: 1 }, { unique: true });
Schema.index({ property_id: 1, requester_id: 1, created_at: -1 });
module.exports = mongoose.models.MoneyRequest || mongoose.model("MoneyRequest", Schema, "money_requests");
