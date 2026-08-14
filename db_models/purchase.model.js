const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const GlLineSchema = new mongoose.Schema({
  account: { type: String, required: true, trim: true, maxlength: 150 },
  amount: { type: Number, required: true, min: 0.01 },
  memo: { type: String, trim: true, maxlength: 500, default: "" }
}, { _id: true });

const PurchaseSchema = new mongoose.Schema({
  property_id: { type: String, required: true, trim: true, maxlength: 100, index: true },
  purchase_no: { type: String, required: true, trim: true, uppercase: true, maxlength: 50 },
  supplier_name: { type: String, required: true, trim: true, maxlength: 200, index: true },
  supplier_invoice_no: { type: String, required: true, trim: true, maxlength: 100 },
  purchase_date: { type: Date, required: true, index: true },
  due_date: { type: Date, required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true, trim: true, uppercase: true, minlength: 3, maxlength: 3, default: "LKR" },
  narration: { type: String, trim: true, maxlength: 1000, default: "" },
  attachments: { type: [String], default: [] },
  gl_lines: { type: [GlLineSchema], default: [] },
  status: { type: String, enum: ["to_be_paid", "paid", "voided"], default: "to_be_paid", index: true },
  created_by: { type: ActorSchema, default: () => ({}) },
  paid_at: { type: Date },
  paid_by: { type: ActorSchema },
  payment_method: { type: String, trim: true, maxlength: 100, default: "" },
  payment_reference: { type: String, trim: true, maxlength: 150, default: "" },
  voided_at: { type: Date },
  voided_by: { type: ActorSchema },
  void_reason: { type: String, trim: true, maxlength: 1000, default: "" }
}, {
  timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  optimisticConcurrency: true
});

PurchaseSchema.index({ property_id: 1, purchase_no: 1 }, { unique: true });
PurchaseSchema.index({ property_id: 1, status: 1, due_date: 1 });
PurchaseSchema.index({ property_id: 1, supplier_name: 1, supplier_invoice_no: 1 }, { unique: true });
PurchaseSchema.pre("validate", function normalizePurchase() {
  this.property_id = String(this.property_id || "").trim();
  this.purchase_no = String(this.purchase_no || "").trim().toUpperCase();
  this.currency = String(this.currency || "LKR").trim().toUpperCase();
  this.amount = money(this.amount);
  if (this.due_date && this.purchase_date && this.due_date < this.purchase_date) {
    this.invalidate("due_date", "Purchase due date cannot be before its purchase date.");
  }
});

function money(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }

module.exports = mongoose.models.Purchase || mongoose.model("Purchase", PurchaseSchema, "purchases");
module.exports.PurchaseSchema = PurchaseSchema;
