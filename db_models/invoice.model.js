const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const INVOICE_STATUSES = [
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "credited",
  "voided"
];

const INVOICE_LINE_CATEGORIES = [
  "accommodation",
  "meal",
  "laundry",
  "minibar",
  "transport",
  "service",
  "tax",
  "adjustment",
  "other"
];

// A snapshot is intentional: an issued invoice must not change when a guest
// later edits their profile.
const BillingSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    address: { type: String, trim: true, maxlength: 500, default: "" },
    country: { type: String, trim: true, maxlength: 100, default: "" },
    tax_number: { type: String, trim: true, maxlength: 100, default: "" }
  },
  { _id: false }
);

const StaySnapshotSchema = new mongoose.Schema(
  {
    check_in: { type: Date, required: true },
    check_out: { type: Date, required: true },
    nights: { type: Number, required: true, min: 0 },
    is_day_room: { type: Boolean, default: false },
    room_numbers: { type: [String], default: [] }
  },
  { _id: false }
);

const InvoiceLineSchema = new mongoose.Schema(
  {
    source_type: {
      type: String,
      enum: INVOICE_LINE_CATEGORIES,
      required: true,
      default: "other"
    },
    source_id: { type: String, trim: true, maxlength: 150, default: "" },
    service_date: { type: Date, required: true },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    room_number: { type: String, trim: true, maxlength: 30, default: "" },
    quantity: { type: Number, required: true, min: 0.01, default: 1 },
    unit_price: { type: Number, required: true, min: 0 },
    discount_amount: { type: Number, min: 0, default: 0 },
    tax_rate: { type: Number, min: 0, max: 100, default: 0 },
    net_amount: { type: Number, min: 0, default: 0 },
    tax_amount: { type: Number, min: 0, default: 0 },
    total_amount: { type: Number, min: 0, default: 0 }
  },
  { _id: true }
);

InvoiceLineSchema.pre("validate", function calculateInvoiceLine() {
  const gross = money(Number(this.quantity || 0) * Number(this.unit_price || 0));
  const discount = money(Number(this.discount_amount || 0));
  if (discount > gross) {
    this.invalidate("discount_amount", "Line discount cannot exceed the gross line amount.");
    return;
  }
  this.net_amount = money(gross - discount);
  this.tax_amount = money(this.net_amount * Number(this.tax_rate || 0) / 100);
  this.total_amount = money(this.net_amount + this.tax_amount);
});

const InvoiceSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    invoice_no: {
      type: String,
      required: [true, "Invoice number is required."],
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    reference_number: { type: String, trim: true, maxlength: 150, default: "" },
    reservation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reservation",
      required: [true, "Reservation ID is required."],
      index: true
    },
    reservation_no: {
      type: String,
      required: [true, "Reservation number is required."],
      trim: true,
      uppercase: true,
      maxlength: 50,
      index: true
    },
    guest_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: [true, "Guest ID is required."],
      index: true
    },
    billing_type: {
      type: String,
      enum: ["guest", "company", "travel_agent"],
      default: "guest"
    },
    billing_snapshot: { type: BillingSnapshotSchema, required: true },
    stay_snapshot: { type: StaySnapshotSchema, required: true },
    invoice_date: { type: Date, required: true, default: Date.now, index: true },
    due_date: { type: Date, required: true, default: Date.now },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3
    },
    line_items: {
      type: [InvoiceLineSchema],
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: "At least one invoice line is required."
      },
      default: []
    },
    subtotal: { type: Number, min: 0, default: 0 },
    discount_total: { type: Number, min: 0, default: 0 },
    tax_total: { type: Number, min: 0, default: 0 },
    grand_total: { type: Number, min: 0, default: 0 },
    paid_amount: { type: Number, min: 0, default: 0 },
    credited_amount: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: INVOICE_STATUSES,
      default: "draft",
      index: true
    },
    notes: { type: String, trim: true, maxlength: 3000, default: "" },
    terms: { type: String, trim: true, maxlength: 3000, default: "" },
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
    optimisticConcurrency: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

InvoiceSchema.virtual("balance_due").get(function getBalanceDue() {
  return money(Math.max(this.grand_total - this.credited_amount - this.paid_amount, 0));
});

InvoiceSchema.virtual("refund_due").get(function getRefundDue() {
  const adjustedInvoiceTotal = Math.max(this.grand_total - this.credited_amount, 0);
  return money(Math.max(this.paid_amount - adjustedInvoiceTotal, 0));
});

InvoiceSchema.index(
  { property_id: 1, invoice_no: 1 },
  { unique: true, name: "unique_invoice_number_per_property" }
);
InvoiceSchema.index({ property_id: 1, reservation_id: 1, invoice_date: -1 });
InvoiceSchema.index({ property_id: 1, guest_id: 1, invoice_date: -1 });
InvoiceSchema.index({ property_id: 1, status: 1, due_date: 1 });
InvoiceSchema.index(
  { property_id: 1, reference_number: 1 },
  {
    unique: true,
    partialFilterExpression: { reference_number: { $type: "string", $gt: "" } },
    name: "unique_non_empty_invoice_reference_per_property"
  }
);

InvoiceSchema.pre("validate", function calculateInvoiceTotals() {
  this.property_id = String(this.property_id || "").trim();
  this.invoice_no = String(this.invoice_no || "").trim().toUpperCase();
  this.reservation_no = String(this.reservation_no || "").trim().toUpperCase();
  this.currency = String(this.currency || "").trim().toUpperCase();

  this.subtotal = money(this.line_items.reduce(
    (total, line) => total + Number(line.quantity || 0) * Number(line.unit_price || 0),
    0
  ));
  this.discount_total = money(this.line_items.reduce(
    (total, line) => total + Number(line.discount_amount || 0),
    0
  ));
  this.tax_total = money(this.line_items.reduce(
    (total, line) => {
      const gross = Number(line.quantity || 0) * Number(line.unit_price || 0);
      const net = Math.max(gross - Number(line.discount_amount || 0), 0);
      return total + net * Number(line.tax_rate || 0) / 100;
    },
    0
  ));
  this.grand_total = money(this.subtotal - this.discount_total + this.tax_total);

  if (this.due_date && this.invoice_date && this.due_date < this.invoice_date) {
    this.invalidate("due_date", "Invoice due date cannot be before the invoice date.");
  }
  if (this.credited_amount > this.grand_total) {
    this.invalidate("credited_amount", "Credited amount cannot exceed the invoice total.");
  }
});

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const Invoice =
  mongoose.models.Invoice ||
  mongoose.model("Invoice", InvoiceSchema, "invoices");

module.exports = Invoice;
module.exports.InvoiceSchema = InvoiceSchema;
module.exports.InvoiceLineSchema = InvoiceLineSchema;
module.exports.INVOICE_STATUSES = INVOICE_STATUSES;
module.exports.INVOICE_LINE_CATEGORIES = INVOICE_LINE_CATEGORIES;
module.exports.money = money;
