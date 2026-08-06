const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");
const { INVOICE_LINE_CATEGORIES, money } = require("./invoice.model");

const CREDIT_NOTE_STATUSES = ["draft", "issued", "voided"];
const CREDIT_REASON_CODES = [
  "billing_error",
  "cancelled_service",
  "overcharge",
  "rate_correction",
  "guest_compensation",
  "tax_correction",
  "other"
];

const CreditLineSchema = new mongoose.Schema(
  {
    invoice_line_id: { type: mongoose.Schema.Types.ObjectId, required: false },
    category: {
      type: String,
      enum: INVOICE_LINE_CATEGORIES,
      required: true,
      default: "other"
    },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    room_number: { type: String, trim: true, maxlength: 30, default: "" },
    quantity: { type: Number, required: true, min: 0.01, default: 1 },
    unit_amount: { type: Number, required: true, min: 0 },
    tax_amount: { type: Number, min: 0, default: 0 },
    net_amount: { type: Number, min: 0, default: 0 },
    total_amount: { type: Number, min: 0, default: 0 }
  },
  { _id: true }
);

CreditLineSchema.pre("validate", function calculateCreditLine() {
  this.net_amount = money(Number(this.quantity || 0) * Number(this.unit_amount || 0));
  this.tax_amount = money(Number(this.tax_amount || 0));
  this.total_amount = money(this.net_amount + this.tax_amount);
});

const GuestSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" }
  },
  { _id: false }
);

const CreditNoteSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    credit_note_no: {
      type: String,
      required: [true, "Credit note number is required."],
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
      required: [true, "Invoice number is required."],
      trim: true,
      uppercase: true,
      maxlength: 50,
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
    guest_snapshot: { type: GuestSnapshotSchema, required: true },
    credit_date: { type: Date, required: true, default: Date.now, index: true },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3
    },
    reason_code: { type: String, enum: CREDIT_REASON_CODES, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    line_items: {
      type: [CreditLineSchema],
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: "At least one credit line is required."
      },
      default: []
    },
    subtotal: { type: Number, min: 0, default: 0 },
    tax_total: { type: Number, min: 0, default: 0 },
    total_credit: { type: Number, min: 0.01, default: 0 },
    status: {
      type: String,
      enum: CREDIT_NOTE_STATUSES,
      default: "draft",
      index: true
    },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    created_by: { type: ActorSchema, default: () => ({}) },
    updated_by: { type: ActorSchema, default: () => ({}) },
    issued_by: { type: ActorSchema, required: false },
    issued_at: { type: Date, required: false },
    voided_by: { type: ActorSchema, required: false },
    voided_at: { type: Date, required: false },
    void_reason: { type: String, trim: true, maxlength: 1000, default: "" }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true
  }
);

CreditNoteSchema.index(
  { property_id: 1, credit_note_no: 1 },
  { unique: true, name: "unique_credit_note_number_per_property" }
);
CreditNoteSchema.index({ property_id: 1, invoice_id: 1, status: 1, credit_date: -1 });
CreditNoteSchema.index({ property_id: 1, reservation_id: 1, credit_date: -1 });

CreditNoteSchema.pre("validate", function calculateCreditTotals() {
  this.property_id = String(this.property_id || "").trim();
  this.credit_note_no = String(this.credit_note_no || "").trim().toUpperCase();
  this.invoice_no = String(this.invoice_no || "").trim().toUpperCase();
  this.reservation_no = String(this.reservation_no || "").trim().toUpperCase();
  this.currency = String(this.currency || "").trim().toUpperCase();
  this.subtotal = money(this.line_items.reduce(
    (total, line) => total + Number(line.quantity || 0) * Number(line.unit_amount || 0),
    0
  ));
  this.tax_total = money(this.line_items.reduce(
    (total, line) => total + Number(line.tax_amount || 0),
    0
  ));
  this.total_credit = money(this.subtotal + this.tax_total);
});

const CreditNote =
  mongoose.models.CreditNote ||
  mongoose.model("CreditNote", CreditNoteSchema, "credit_notes");

module.exports = CreditNote;
module.exports.CreditNoteSchema = CreditNoteSchema;
module.exports.CreditLineSchema = CreditLineSchema;
module.exports.CREDIT_NOTE_STATUSES = CREDIT_NOTE_STATUSES;
module.exports.CREDIT_REASON_CODES = CREDIT_REASON_CODES;
