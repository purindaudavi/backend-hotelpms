const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const WITHDRAWAL_STATUSES = ["completed", "voided"];
const SOURCE_ACCOUNTS = ["cash_on_hand", "petty_cash", "main_bank_account", "other"];
const PAYMENT_METHODS = ["cash", "bank_transfer", "cheque", "other"];

const WithdrawalSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    withdrawal_no: {
      type: String,
      required: [true, "Withdrawal number is required."],
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    paid_to: {
      type: String,
      required: [true, "Paid-to name is required."],
      trim: true,
      maxlength: 150,
      default: "ASIRI PERERA",
      immutable: true
    },
    amount: {
      type: Number,
      required: [true, "Withdrawal amount is required."],
      min: [0.01, "Withdrawal amount must be greater than zero."]
    },
    currency: {
      type: String,
      required: [true, "Currency is required."],
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      default: "LKR"
    },
    source_account: {
      type: String,
      enum: SOURCE_ACCOUNTS,
      required: [true, "Source account is required."]
    },
    payment_method: {
      type: String,
      enum: PAYMENT_METHODS,
      required: [true, "Payment method is required."]
    },
    reason: {
      type: String,
      required: [true, "Withdrawal reason is required."],
      trim: true,
      maxlength: 1000
    },
    money_received_at: {
      type: Date,
      required: [true, "The money received date and time is required."],
      index: true
    },
    reference_number: { type: String, trim: true, maxlength: 150, default: "" },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    status: {
      type: String,
      enum: WITHDRAWAL_STATUSES,
      default: "completed",
      index: true
    },
    recorded_by: { type: ActorSchema, default: () => ({}) },
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

WithdrawalSchema.index(
  { property_id: 1, withdrawal_no: 1 },
  { unique: true, name: "unique_withdrawal_number_per_property" }
);
WithdrawalSchema.index({ property_id: 1, status: 1, money_received_at: -1 });
WithdrawalSchema.index(
  { property_id: 1, reference_number: 1 },
  {
    unique: true,
    partialFilterExpression: { reference_number: { $type: "string", $gt: "" } },
    name: "unique_non_empty_withdrawal_reference_per_property"
  }
);

WithdrawalSchema.pre("validate", function normalizeWithdrawal() {
  this.property_id = String(this.property_id || "").trim();
  this.withdrawal_no = String(this.withdrawal_no || "").trim().toUpperCase();
  this.paid_to = String(this.paid_to || "ASIRI PERERA").trim();
  this.currency = String(this.currency || "LKR").trim().toUpperCase();
  this.source_account = normalizeEnum(this.source_account);
  this.payment_method = normalizeEnum(this.payment_method);
  this.amount = money(this.amount);
});

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const Withdrawal =
  mongoose.models.Withdrawal ||
  mongoose.model("Withdrawal", WithdrawalSchema, "withdrawals");

module.exports = Withdrawal;
module.exports.WithdrawalSchema = WithdrawalSchema;
module.exports.WITHDRAWAL_STATUSES = WITHDRAWAL_STATUSES;
module.exports.SOURCE_ACCOUNTS = SOURCE_ACCOUNTS;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
