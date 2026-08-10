const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const REFUND_STATUSES = ["pending", "completed", "voided"];
const REFUND_METHODS = [
  "cash",
  "credit_card",
  "debit_card",
  "bank_transfer",
  "online",
  "other"
];

const RefundSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    refund_no: {
      type: String,
      required: [true, "Refund number is required."],
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    invoice_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: [true, "Invoice ID is required."],
      index: true
    },
    invoice_no: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    payment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReservationPayment",
      required: [true, "Original payment ID is required."],
      index: true
    },
    reservation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reservation",
      required: true,
      index: true
    },
    reservation_no: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    guest_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: true,
      index: true
    },
    amount: {
      type: Number,
      required: [true, "Refund amount is required."],
      min: [0.01, "Refund amount must be greater than zero."]
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3
    },
    refund_method: {
      type: String,
      enum: REFUND_METHODS,
      required: [true, "Refund method is required."]
    },
    reference_number: {
      type: String,
      trim: true,
      maxlength: 150,
      default: ""
    },
    reason: {
      type: String,
      required: [true, "Refund reason is required."],
      trim: true,
      maxlength: 1000
    },
    status: {
      type: String,
      enum: REFUND_STATUSES,
      default: "pending",
      index: true
    },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    requested_at: { type: Date, required: true, default: Date.now },
    requested_by: { type: ActorSchema, default: () => ({}) },
    updated_by: { type: ActorSchema, default: () => ({}) },
    completed_at: { type: Date, required: false },
    completed_by: { type: ActorSchema, required: false },
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

RefundSchema.index(
  { property_id: 1, refund_no: 1 },
  { unique: true, name: "unique_refund_number_per_property" }
);
RefundSchema.index({ property_id: 1, invoice_id: 1, status: 1, requested_at: -1 });
RefundSchema.index({ property_id: 1, payment_id: 1, status: 1 });
RefundSchema.index({ property_id: 1, reservation_id: 1, requested_at: -1 });
RefundSchema.index(
  { property_id: 1, reference_number: 1 },
  {
    unique: true,
    partialFilterExpression: { reference_number: { $type: "string", $gt: "" } },
    name: "unique_non_empty_refund_reference_per_property"
  }
);

RefundSchema.pre("validate", function normalizeRefund() {
  this.property_id = String(this.property_id || "").trim();
  this.refund_no = String(this.refund_no || "").trim().toUpperCase();
  this.invoice_no = String(this.invoice_no || "").trim().toUpperCase();
  this.reservation_no = String(this.reservation_no || "").trim().toUpperCase();
  this.currency = String(this.currency || "").trim().toUpperCase();
  this.refund_method = String(this.refund_method || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  this.amount = money(this.amount);
});

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const Refund =
  mongoose.models.Refund ||
  mongoose.model("Refund", RefundSchema, "refunds");

module.exports = Refund;
module.exports.RefundSchema = RefundSchema;
module.exports.REFUND_STATUSES = REFUND_STATUSES;
module.exports.REFUND_METHODS = REFUND_METHODS;
