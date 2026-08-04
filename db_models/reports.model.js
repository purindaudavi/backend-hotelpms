const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const REPORT_TYPES = [
  "collection-report",
  "deposit-ledger",
  "trial-balance",
  "profit-loss",
  "revenue-report",
  "revenue-forecast",
  "invoice-daybook",
  "customer-balance-summary",
  "ar-aging-summary",
  "in-house-guest-ledger",
  "information-sheet",
  "reservation-list",
  "business-analysis",
  "arrival-list",
  "travel-agent-performance",
  "inventory-by-room-type",
  "occupancy-by-date"
];

const ReportParametersSchema = new mongoose.Schema(
  {
    date_from: { type: Date, required: true },
    date_to: { type: Date, required: true },
    as_of: { type: Date, required: true },
    currency: { type: String, trim: true, uppercase: true, maxlength: 3, default: "" },
    reservation_status: { type: String, trim: true, maxlength: 40, default: "" }
  },
  { _id: false }
);

const ReportRunSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    report_type: {
      type: String,
      required: [true, "Report type is required."],
      enum: REPORT_TYPES,
      index: true
    },
    title: {
      type: String,
      required: [true, "Report title is required."],
      trim: true,
      maxlength: 150
    },
    parameters: { type: ReportParametersSchema, required: true },
    status: {
      type: String,
      enum: ["generated", "failed"],
      default: "generated",
      index: true
    },
    row_count: { type: Number, min: 0, default: 0 },
    summary: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    totals: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    limitations: { type: [String], default: [] },
    error_message: { type: String, trim: true, maxlength: 2000, default: "" },
    generated_at: { type: Date, required: true, default: Date.now, index: true },
    generated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    toJSON: {
      transform(_document, result) {
        result.version = result.__v;
        delete result.__v;
        return result;
      }
    }
  }
);

ReportRunSchema.index({ property_id: 1, generated_at: -1 });
ReportRunSchema.index({ property_id: 1, report_type: 1, generated_at: -1 });

ReportRunSchema.pre("validate", function normalizeReportRun() {
  this.property_id = String(this.property_id || "").trim();
  this.report_type = String(this.report_type || "").trim().toLowerCase();
  this.title = String(this.title || "").replace(/\s+/g, " ").trim();
  this.limitations = Array.from(
    new Set((this.limitations || []).map((value) => String(value).trim()).filter(Boolean))
  );

  if (
    this.parameters?.date_from &&
    this.parameters?.date_to &&
    this.parameters.date_to < this.parameters.date_from
  ) {
    this.invalidate("parameters.date_to", "Report date_to cannot be before date_from.");
  }
});

const ReportRun =
  mongoose.models.ReportRun ||
  mongoose.model("ReportRun", ReportRunSchema, "report_runs");

module.exports = ReportRun;
module.exports.ReportRunSchema = ReportRunSchema;
module.exports.REPORT_TYPES = REPORT_TYPES;
