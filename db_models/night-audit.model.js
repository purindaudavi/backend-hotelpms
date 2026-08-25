const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const NIGHT_AUDIT_STATUSES = ["open", "closed"];
const NIGHT_AUDIT_STEP_IDS = [
  "front-desk-status",
  "folio-posting",
  "payment-reconciliation",
  "housekeeping-close",
  "channel-check",
  "audit-reports"
];

const OverrideSchema = new mongoose.Schema(
  {
    step_id: { type: String, enum: NIGHT_AUDIT_STEP_IDS, required: true },
    exception_id: { type: String, required: true, trim: true, maxlength: 200 },
    reason: { type: String, required: true, trim: true, minlength: 10, maxlength: 1000 },
    approved_by: { type: ActorSchema, default: () => ({}) },
    approved_at: { type: Date, required: true, default: Date.now }
  },
  { _id: true }
);

const ReportReferenceSchema = new mongoose.Schema(
  {
    report_type: { type: String, required: true, trim: true, maxlength: 80 },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    report_run_id: { type: mongoose.Schema.Types.ObjectId, ref: "ReportRun", required: true },
    generated_at: { type: Date, required: true }
  },
  { _id: false }
);

const NightAuditSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    business_date: {
      type: Date,
      required: [true, "Business date is required."],
      index: true
    },
    status: {
      type: String,
      enum: NIGHT_AUDIT_STATUSES,
      default: "open",
      index: true
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      default: "LKR"
    },
    reviewed_step_ids: [{ type: String, enum: NIGHT_AUDIT_STEP_IDS }],
    overrides: { type: [OverrideSchema], default: [] },
    revenue_posted_at: { type: Date, required: false },
    revenue_posted_amount: { type: Number, min: 0, default: 0 },
    revenue_transaction_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FinancialTransaction",
      required: false
    },
    reports_generated_at: { type: Date, required: false },
    reports: { type: [ReportReferenceSchema], default: [] },
    close_note: { type: String, trim: true, maxlength: 3000, default: "" },
    close_summary: { type: mongoose.Schema.Types.Mixed, default: undefined },
    closed_at: { type: Date, required: false },
    closed_by: { type: ActorSchema, required: false },
    next_business_date: { type: Date, required: false },
    created_by: { type: ActorSchema, default: () => ({}) },
    updated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    versionKey: "version",
    collection: "night_audits"
  }
);

NightAuditSchema.index(
  { property_id: 1, business_date: 1 },
  { unique: true, name: "one_night_audit_per_property_business_date" }
);
NightAuditSchema.index({ property_id: 1, status: 1, business_date: -1 });

NightAuditSchema.pre("validate", function normalizeNightAudit() {
  this.property_id = String(this.property_id || "").trim();
  this.currency = String(this.currency || "LKR").trim().toUpperCase();
  this.reviewed_step_ids = Array.from(new Set(this.reviewed_step_ids || []));
  this.close_note = String(this.close_note || "").trim();

  if (this.status === "closed" && (!this.closed_at || !this.next_business_date)) {
    this.invalidate("status", "A closed night audit requires closed_at and next_business_date.");
  }
});

const NightAudit =
  mongoose.models.NightAudit ||
  mongoose.model("NightAudit", NightAuditSchema, "night_audits");

module.exports = NightAudit;
module.exports.NightAuditSchema = NightAuditSchema;
module.exports.NIGHT_AUDIT_STATUSES = NIGHT_AUDIT_STATUSES;
module.exports.NIGHT_AUDIT_STEP_IDS = NIGHT_AUDIT_STEP_IDS;
