const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const TRANSACTION_DIRECTIONS = ["in", "out", "non_cash", "transfer"];
const TRANSACTION_STATUSES = ["posted", "voided"];
const TRANSACTION_SOURCE_TYPES = [
  "invoice",
  "payment",
  "credit_note",
  "refund",
  "withdrawal",
  "purchase",
  "supplier_payment",
  "expense"
];
const TRANSACTION_EFFECTS = ["increase", "decrease", "neutral"];

const FinancialTransactionSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    transaction_no: {
      type: String,
      required: [true, "Transaction number is required."],
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    transaction_date: {
      type: Date,
      required: [true, "Transaction date is required."],
      default: Date.now,
      index: true
    },
    source_type: {
      type: String,
      enum: TRANSACTION_SOURCE_TYPES,
      required: true,
      index: true
    },
    source_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    source_number: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    direction: {
      type: String,
      enum: TRANSACTION_DIRECTIONS,
      required: true,
      default: "out",
      index: true
    },
    accounting_effect: {
      type: String,
      enum: TRANSACTION_EFFECTS,
      required: true,
      default: "neutral",
      index: true
    },
    amount: {
      type: Number,
      required: [true, "Transaction amount is required."],
      min: [0.01, "Transaction amount must be greater than zero."]
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3
    },
    reservation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reservation",
      required: false,
      index: true
    },
    reservation_no: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 50,
      default: ""
    },
    room_numbers: {
      type: [String],
      default: []
    },
    description: {
      type: String,
      required: [true, "Transaction description is required."],
      trim: true,
      maxlength: 1000
    },
    status: {
      type: String,
      enum: TRANSACTION_STATUSES,
      default: "posted",
      index: true
    },
    created_by: { type: ActorSchema, default: () => ({}) },
    voided_at: { type: Date, required: false },
    voided_by: { type: ActorSchema, required: false },
    void_reason: { type: String, trim: true, maxlength: 1000, default: "" }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

FinancialTransactionSchema.index(
  { property_id: 1, transaction_no: 1 },
  { unique: true, name: "unique_financial_transaction_number_per_property" }
);
FinancialTransactionSchema.index(
  { property_id: 1, source_type: 1, source_id: 1 },
  { unique: true, name: "one_financial_transaction_per_source" }
);
FinancialTransactionSchema.index({ property_id: 1, transaction_date: -1, status: 1 });
FinancialTransactionSchema.index({ property_id: 1, reservation_id: 1, transaction_date: -1 });

FinancialTransactionSchema.pre("validate", function normalizeTransaction() {
  this.property_id = String(this.property_id || "").trim();
  this.transaction_no = String(this.transaction_no || "").trim().toUpperCase();
  this.source_type = normalizeEnum(this.source_type);
  this.source_number = String(this.source_number || "").trim().toUpperCase();
  this.direction = normalizeEnum(this.direction);
  this.accounting_effect = normalizeEnum(this.accounting_effect);
  this.currency = String(this.currency || "").trim().toUpperCase();
  this.reservation_no = String(this.reservation_no || "").trim().toUpperCase();
  this.room_numbers = [...new Set((this.room_numbers || []).map((value) => String(value).trim()).filter(Boolean))];
  this.amount = money(this.amount);
});

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const FinancialTransaction =
  mongoose.models.FinancialTransaction ||
  mongoose.model("FinancialTransaction", FinancialTransactionSchema, "financial_transactions");

module.exports = FinancialTransaction;
module.exports.FinancialTransactionSchema = FinancialTransactionSchema;
module.exports.TRANSACTION_DIRECTIONS = TRANSACTION_DIRECTIONS;
module.exports.TRANSACTION_STATUSES = TRANSACTION_STATUSES;
module.exports.TRANSACTION_SOURCE_TYPES = TRANSACTION_SOURCE_TYPES;
module.exports.TRANSACTION_EFFECTS = TRANSACTION_EFFECTS;
