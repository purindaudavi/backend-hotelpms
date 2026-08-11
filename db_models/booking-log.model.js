const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const ChangeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true, trim: true, maxlength: 200 },
    from: { type: mongoose.Schema.Types.Mixed, required: false },
    to: { type: mongoose.Schema.Types.Mixed, required: false }
  },
  { _id: false }
);

const BookingAuditLogSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true
    },
    entity_type: {
      type: String,
      enum: [
        "reservation",
        "business_block",
        "invoice",
        "credit_note",
        "refund",
        "travel_agent",
        "housekeeping_task"
      ],
      required: true,
      index: true
    },
    entity_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    action: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    changes: { type: [ChangeSchema], default: [] },
    actor: { type: ActorSchema, default: () => ({}) },
    request_id: { type: String, trim: true, maxlength: 150, default: "" },
    created_at: { type: Date, required: true, default: Date.now, immutable: true }
  },
  {
    versionKey: false,
    timestamps: false
  }
);

BookingAuditLogSchema.index({
  property_id: 1,
  entity_type: 1,
  entity_id: 1,
  created_at: -1
});

const BookingAuditLog =
  mongoose.models.BookingAuditLog ||
  mongoose.model(
    "BookingAuditLog",
    BookingAuditLogSchema,
    "booking_audit_logs"
  );

module.exports = BookingAuditLog;
