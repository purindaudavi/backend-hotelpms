const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const DOCUMENT_CATEGORIES = [
  "voucher",
  "payment_receipt",
  "authorization_letter",
  "rooming_list",
  "signed_form",
  "other"
];

const ReservationAttachmentSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true
    },
    reservation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reservation",
      required: true,
      index: true
    },
    file_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true
    },
    file_name: { type: String, required: true, trim: true, maxlength: 255 },
    content_type: { type: String, required: true, trim: true, maxlength: 150 },
    file_size: { type: Number, required: true, min: 1 },
    document_category: {
      type: String,
      enum: DOCUMENT_CATEGORIES,
      default: "other"
    },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    uploaded_by: { type: ActorSchema, default: () => ({}) },
    uploaded_at: { type: Date, required: true, default: Date.now },
    deleted_at: { type: Date, required: false }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    toJSON: {
      transform(_document, result) {
        delete result.__v;
        return result;
      }
    }
  }
);

ReservationAttachmentSchema.index({
  property_id: 1,
  reservation_id: 1,
  uploaded_at: -1
});

const ReservationAttachment =
  mongoose.models.ReservationAttachment ||
  mongoose.model(
    "ReservationAttachment",
    ReservationAttachmentSchema,
    "reservation_attachments"
  );

module.exports = ReservationAttachment;
module.exports.DOCUMENT_CATEGORIES = DOCUMENT_CATEGORIES;
