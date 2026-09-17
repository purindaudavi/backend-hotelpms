const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const FinancialTargetSchema = new mongoose.Schema({
  property_id: { type: String, required: true, trim: true, maxlength: 100, index: true },
  month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true },
  metric: { type: String, enum: ["net_profit"], default: "net_profit", required: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true, trim: true, uppercase: true, minlength: 3, maxlength: 3, default: "LKR" },
  created_by: { type: ActorSchema, default: () => ({}) },
  updated_by: { type: ActorSchema, default: () => ({}) }
}, {
  timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  optimisticConcurrency: true
});

FinancialTargetSchema.index(
  { property_id: 1, month: 1, metric: 1, currency: 1 },
  { unique: true, name: "one_financial_target_per_property_month_metric_currency" }
);

FinancialTargetSchema.pre("validate", function normalizeFinancialTarget() {
  this.property_id = String(this.property_id || "").trim();
  this.month = String(this.month || "").trim();
  this.metric = "net_profit";
  this.currency = String(this.currency || "LKR").trim().toUpperCase();
  this.amount = Math.round((Number(this.amount) + Number.EPSILON) * 100) / 100;
});

module.exports = mongoose.models.FinancialTarget || mongoose.model("FinancialTarget", FinancialTargetSchema, "financial_targets");
module.exports.FinancialTargetSchema = FinancialTargetSchema;
