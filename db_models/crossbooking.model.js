const mongoose = require("mongoose");

const CrossBookingSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    room_a_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, "First physical room ID is required."],
      index: true
    },
    room_b_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, "Second physical room ID is required."],
      index: true
    },
    room_a_number: {
      type: String,
      required: [true, "First room number is required."],
      trim: true,
      maxlength: 30
    },
    room_b_number: {
      type: String,
      required: [true, "Second room number is required."],
      trim: true,
      maxlength: 30
    },
    room_a_type_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: [true, "First room type ID is required."]
    },
    room_b_type_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: [true, "Second room type ID is required."]
    },
    room_a_type_name: {
      type: String,
      required: [true, "First room type name is required."],
      trim: true,
      maxlength: 120
    },
    room_b_type_name: {
      type: String,
      required: [true, "Second room type name is required."],
      trim: true,
      maxlength: 120
    },
    active: {
      type: Boolean,
      default: true,
      index: true
    },
    created_by: {
      type: String,
      trim: true,
      maxlength: 150,
      default: "System"
    },
    updated_by: {
      type: String,
      trim: true,
      maxlength: 150,
      default: "System"
    }
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
    },
    toObject: {
      transform(_document, result) {
        result.version = result.__v;
        delete result.__v;
        return result;
      }
    }
  }
);

CrossBookingSchema.index(
  { property_id: 1, room_a_id: 1, room_b_id: 1 },
  { unique: true, name: "unique_cross_booking_pair_per_property" }
);
CrossBookingSchema.index({ property_id: 1, active: 1, room_a_id: 1 });
CrossBookingSchema.index({ property_id: 1, active: 1, room_b_id: 1 });

CrossBookingSchema.pre("validate", function normalizeCrossBookingPair() {
  if (
    this.room_a_id &&
    this.room_b_id &&
    String(this.room_a_id) === String(this.room_b_id)
  ) {
    this.invalidate("room_b_id", "A room cannot be cross-booked with itself.");
    return;
  }

  if (
    this.room_a_id &&
    this.room_b_id &&
    String(this.room_a_id).localeCompare(String(this.room_b_id)) > 0
  ) {
    swap(this, "room_a_id", "room_b_id");
    swap(this, "room_a_number", "room_b_number");
    swap(this, "room_a_type_id", "room_b_type_id");
    swap(this, "room_a_type_name", "room_b_type_name");
  }
});

function swap(document, firstField, secondField) {
  const first = document[firstField];
  document[firstField] = document[secondField];
  document[secondField] = first;
}

const CrossBooking =
  mongoose.models.CrossBooking ||
  mongoose.model("CrossBooking", CrossBookingSchema, "cross_bookings");

module.exports = CrossBooking;
module.exports.CrossBookingSchema = CrossBookingSchema;
