const mongoose = require("mongoose");

const EVENT_STATUSES = ["confirmed", "tentative", "blocked"];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const CreateEventSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    title: {
      type: String,
      required: [true, "Event title is required."],
      trim: true,
      maxlength: 160
    },
    venue: {
      type: String,
      required: [true, "Venue is required."],
      trim: true,
      maxlength: 120
    },
    venue_key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      select: false
    },
    event_date: {
      type: Date,
      required: [true, "Event date is required."],
      index: true
    },
    start_time: {
      type: String,
      required: [true, "Start time is required."],
      match: [TIME_PATTERN, "Start time must use HH:mm format."]
    },
    end_time: {
      type: String,
      required: [true, "End time is required."],
      match: [TIME_PATTERN, "End time must use HH:mm format."]
    },
    owner: {
      type: String,
      required: [true, "Event owner is required."],
      trim: true,
      maxlength: 120
    },
    status: {
      type: String,
      enum: {
        values: EVENT_STATUSES,
        message: "Status must be confirmed, tentative, or blocked."
      },
      default: "confirmed",
      lowercase: true,
      trim: true,
      index: true
    },
    description: {
      type: String,
      trim: true,
      maxlength: 3000,
      default: ""
    },
    created_by: {
      type: String,
      trim: true,
      maxlength: 120,
      default: ""
    },
    updated_by: {
      type: String,
      trim: true,
      maxlength: 120,
      default: ""
    }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    toJSON: {
      transform(_document, result) {
        result.version = result.__v;
        delete result.__v;
        delete result.venue_key;
        return result;
      }
    },
    toObject: {
      transform(_document, result) {
        result.version = result.__v;
        delete result.__v;
        delete result.venue_key;
        return result;
      }
    }
  }
);

CreateEventSchema.index(
  {
    property_id: 1,
    event_date: 1,
    venue_key: 1,
    start_time: 1,
    end_time: 1
  },
  { name: "event_calendar_lookup" }
);

CreateEventSchema.index({
  property_id: 1,
  status: 1,
  event_date: 1
});

CreateEventSchema.pre("validate", function normalizeAndValidateEvent() {
  this.title = normalizeSpaces(this.title);
  this.venue = normalizeSpaces(this.venue);
  this.owner = normalizeSpaces(this.owner);
  this.venue_key = this.venue.toLowerCase();

  if (this.event_date instanceof Date && !Number.isNaN(this.event_date.getTime())) {
    this.event_date.setUTCHours(0, 0, 0, 0);
  }

  if (
    TIME_PATTERN.test(this.start_time || "") &&
    TIME_PATTERN.test(this.end_time || "") &&
    this.end_time <= this.start_time
  ) {
    this.invalidate("end_time", "End time must be later than start time.");
  }
});

function normalizeSpaces(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

const CreateEvent =
  mongoose.models.CreateEvent ||
  mongoose.model("CreateEvent", CreateEventSchema, "events");

module.exports = CreateEvent;
module.exports.EVENT_STATUSES = EVENT_STATUSES;
