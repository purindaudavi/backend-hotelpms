const mongoose = require("mongoose");

const NotificationReadStateSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true
    },
    user_id: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      index: true
    },
    read_notification_ids: {
      type: [String],
      default: []
    },
    read_through_at: {
      type: Date,
      required: false
    }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
  }
);

NotificationReadStateSchema.index(
  { property_id: 1, user_id: 1 },
  { unique: true, name: "one_notification_read_state_per_property_user" }
);

NotificationReadStateSchema.pre("validate", function normalizeNotificationReadState() {
  this.property_id = String(this.property_id || "").trim();
  this.user_id = String(this.user_id || "").trim().toLowerCase();
  this.read_notification_ids = [...new Set(
    (this.read_notification_ids || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )].slice(-500);
});

module.exports =
  mongoose.models.NotificationReadState ||
  mongoose.model(
    "NotificationReadState",
    NotificationReadStateSchema,
    "notification_read_states"
  );
module.exports.NotificationReadStateSchema = NotificationReadStateSchema;
