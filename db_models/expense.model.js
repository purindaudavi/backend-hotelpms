const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const ExpenseSchema = new mongoose.Schema({
  property_id: { type: String, required: true, trim: true, maxlength: 100, index: true },
  expense_no: { type: String, required: true, trim: true, uppercase: true, maxlength: 50 },
  expense_date: { type: Date, required: true, index: true },
  expense_type: { type: String, required: true, trim: true, maxlength: 150, index: true },
  paid_using: { type: String, required: true, trim: true, maxlength: 150 },
  description: { type: String, trim: true, maxlength: 1000, default: "" },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true, trim: true, uppercase: true, minlength: 3, maxlength: 3, default: "LKR" },
  attachments: { type: [String], default: [] },
  remark: { type: String, trim: true, maxlength: 1000, default: "" },
  status: { type: String, enum: ["posted", "voided"], default: "posted", index: true },
  created_by: { type: ActorSchema, default: () => ({}) },
  voided_at: { type: Date },
  voided_by: { type: ActorSchema },
  void_reason: { type: String, trim: true, maxlength: 1000, default: "" }
}, {
  timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  optimisticConcurrency: true
});

ExpenseSchema.index({ property_id: 1, expense_no: 1 }, { unique: true });
ExpenseSchema.index({ property_id: 1, status: 1, expense_date: -1 });
ExpenseSchema.pre("validate", function normalizeExpense() {
  this.property_id = String(this.property_id || "").trim();
  this.expense_no = String(this.expense_no || "").trim().toUpperCase();
  this.currency = String(this.currency || "LKR").trim().toUpperCase();
  this.amount = Math.round((Number(this.amount) + Number.EPSILON) * 100) / 100;
});

module.exports = mongoose.models.Expense || mongoose.model("Expense", ExpenseSchema, "expenses");
module.exports.ExpenseSchema = ExpenseSchema;
