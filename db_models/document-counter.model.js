const mongoose = require("mongoose");

const DocumentCounterSchema = new mongoose.Schema(
  {
    property_id: { type: String, required: true, trim: true, maxlength: 100 },
    document_type: {
      type: String,
      enum: ["invoice", "credit_note", "refund"],
      required: true
    },
    year: { type: Number, required: true, min: 2000, max: 9999 },
    sequence: { type: Number, required: true, min: 0, default: 0 }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    versionKey: false
  }
);

DocumentCounterSchema.index(
  { property_id: 1, document_type: 1, year: 1 },
  { unique: true, name: "unique_financial_document_counter" }
);

module.exports =
  mongoose.models.DocumentCounter ||
  mongoose.model("DocumentCounter", DocumentCounterSchema, "document_counters");
