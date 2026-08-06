const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const ReservationPaymentSchema = new mongoose.Schema(
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
    invoice_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: false,
      index: true
    },
    invoice_no: { type: String, trim: true, uppercase: true, maxlength: 50, default: "" },
    amount: { type: Number, required: true, min: 0.01 },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3
    },
    payment_method: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    payment_reference: { type: String, trim: true, maxlength: 150, default: "" },
    status: {
      type: String,
      enum: ["posted", "voided", "refunded"],
      default: "posted",
      index: true
    },
    posted_at: { type: Date, required: true, default: Date.now },
    posted_by: { type: ActorSchema, default: () => ({}) },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    voided_at: { type: Date, required: false },
    voided_by: { type: ActorSchema, required: false },
    void_reason: { type: String, trim: true, maxlength: 1000, default: "" }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    toJSON: {
      transform(_document, result) {
        result.version = result.__v;
        delete result.__v;
        return result;
      }
    }
  }
);

ReservationPaymentSchema.index({
  property_id: 1,
  reservation_id: 1,
  status: 1,
  posted_at: -1
});
ReservationPaymentSchema.index({ property_id: 1, invoice_id: 1, status: 1, posted_at: -1 });

const ReservationPayment =
  mongoose.models.ReservationPayment ||
  mongoose.model(
    "ReservationPayment",
    ReservationPaymentSchema,
    "reservation_payments"
  );

module.exports = ReservationPayment;
