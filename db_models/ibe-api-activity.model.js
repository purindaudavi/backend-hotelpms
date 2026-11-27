const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  property_id: { type: String, required: true, maxlength: 100 },
  operation: { type: String, required: true, enum: ["hotel_details", "availability", "booking_created", "booking_retrieved", "booking_failed", "request_failed"] },
  origin: { type: String, default: "", maxlength: 300 },
  integration_id: { type: String, default: "", maxlength: 24 },
  integration_name: { type: String, default: "", maxlength: 100 },
  data_shared: [{ type: String, maxlength: 60 }],
  status_code: { type: Number, required: true },
  check_in: { type: String, maxlength: 10, default: "" },
  check_out: { type: String, maxlength: 10, default: "" },
  room_options: { type: Number, min: 0 },
  reservation_no: { type: String, maxlength: 50, default: "" },
  created_at: { type: Date, default: Date.now, required: true }
}, { versionKey: false });

schema.index({ property_id: 1, created_at: -1 });
schema.index({ property_id: 1, origin: 1, status_code: 1, created_at: -1 });
schema.index({ property_id: 1, integration_id: 1, status_code: 1, created_at: -1 });
schema.index({ created_at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model("IbeApiActivity", schema, "ibe_api_activities");
