const mongoose = require("mongoose");

const SELL_MODES = ["per_room", "per_person"];
const RATE_MODES = ["manual", "derived"];

const RoomTypeRateSchema = new mongoose.Schema(
  {
    room_type_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: [true, "Room type ID is required."]
    },
    amount: {
      type: Number,
      required: [true, "Room-type rate amount is required."],
      min: [0, "Room-type rate amount cannot be negative."]
    }
  },
  { _id: false }
);

const RatePlanSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    name: {
      type: String,
      required: [true, "Rate plan name is required."],
      trim: true,
      maxlength: 150
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    code: {
      type: String,
      required: [true, "Rate plan code is required."],
      trim: true,
      uppercase: true,
      maxlength: 30
    },
    currency: {
      type: String,
      required: [true, "Currency is required."],
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      default: "LKR"
    },
    meal_plan: {
      type: String,
      required: [true, "Meal plan is required."],
      trim: true,
      maxlength: 100,
      default: "Room Only"
    },
    valid_from: {
      type: Date,
      required: [true, "Rate plan start date is required."],
      index: true
    },
    valid_to: {
      type: Date,
      required: [true, "Rate plan end date is required."],
      index: true
    },
    refundable: {
      type: Boolean,
      default: true
    },
    cancellation_policy: {
      type: String,
      required: [true, "Cancellation policy is required."],
      trim: true,
      maxlength: 3000
    },
    resident: {
      type: Boolean,
      default: false
    },
    sell_mode: {
      type: String,
      enum: SELL_MODES,
      default: "per_room"
    },
    rate_mode: {
      type: String,
      enum: RATE_MODES,
      default: "manual"
    },
    room_type_rates: {
      type: [RoomTypeRateSchema],
      validate: {
        validator: (rates) => Array.isArray(rates) && rates.length > 0,
        message: "At least one room-type rate is required."
      },
      default: []
    },
    active: {
      type: Boolean,
      default: true,
      index: true
    },
    locked: {
      type: Boolean,
      default: false
    },
    is_custom: {
      type: Boolean,
      default: false
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
    toObject: { virtuals: true }
  }
);

RatePlanSchema.index(
  { property_id: 1, code: 1 },
  { unique: true, name: "unique_rate_plan_code_per_property" }
);
RatePlanSchema.index(
  { property_id: 1, slug: 1 },
  { unique: true, name: "unique_rate_plan_name_per_property" }
);
RatePlanSchema.index({ property_id: 1, active: 1, valid_from: 1, valid_to: 1 });

RatePlanSchema.pre("validate", function normalizeAndValidateRatePlan() {
  this.property_id = String(this.property_id || "").trim();
  this.name = normalizeText(this.name);
  this.slug = slugify(this.name);
  this.code = String(this.code || "").trim().toUpperCase();
  this.currency = String(this.currency || "").trim().toUpperCase();
  this.meal_plan = normalizeText(this.meal_plan);
  this.cancellation_policy = String(this.cancellation_policy || "").trim();

  if (this.valid_from && this.valid_to && this.valid_to < this.valid_from) {
    this.invalidate("valid_to", "Rate plan valid_to cannot be before valid_from.");
  }

  const roomTypeIds = (this.room_type_rates || []).map((rate) =>
    String(rate.room_type_id || "")
  );
  if (new Set(roomTypeIds).size !== roomTypeIds.length) {
    this.invalidate(
      "room_type_rates",
      "A room type can appear only once in a rate plan."
    );
  }
});

const DailyRateSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    rate_plan_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RatePlan",
      required: [true, "Rate plan ID is required."],
      index: true
    },
    room_type_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: [true, "Room type ID is required."],
      index: true
    },
    date: {
      type: Date,
      required: [true, "Daily rate date is required."],
      index: true
    },
    amount: {
      type: Number,
      required: [true, "Daily rate amount is required."],
      min: [0, "Daily rate amount cannot be negative."]
    },
    stop_sell: {
      type: Boolean,
      default: false
    },
    minimum_stay: {
      type: Number,
      min: 1,
      max: 365,
      default: 1
    },
    maximum_stay: {
      type: Number,
      min: 1,
      max: 730,
      default: null
    },
    closed_to_arrival: {
      type: Boolean,
      default: false
    },
    closed_to_departure: {
      type: Boolean,
      default: false
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
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
        return result;
      }
    }
  }
);

DailyRateSchema.index(
  { property_id: 1, rate_plan_id: 1, room_type_id: 1, date: 1 },
  { unique: true, name: "unique_daily_rate" }
);
DailyRateSchema.index({ property_id: 1, room_type_id: 1, date: 1 });

DailyRateSchema.pre("validate", function normalizeAndValidateDailyRate() {
  this.property_id = String(this.property_id || "").trim();
  if (this.date && !Number.isNaN(this.date.getTime())) {
    this.date = startOfUtcDay(this.date);
  }
  if (
    this.maximum_stay !== null &&
    this.maximum_stay !== undefined &&
    this.maximum_stay < this.minimum_stay
  ) {
    this.invalidate(
      "maximum_stay",
      "Daily rate maximum_stay cannot be less than minimum_stay."
    );
  }
});

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function startOfUtcDay(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const RatePlan =
  mongoose.models.RatePlan ||
  mongoose.model("RatePlan", RatePlanSchema, "rate_plans");

const DailyRate =
  mongoose.models.DailyRate ||
  mongoose.model("DailyRate", DailyRateSchema, "daily_rates");

module.exports = RatePlan;
module.exports.RatePlan = RatePlan;
module.exports.DailyRate = DailyRate;
module.exports.RatePlanSchema = RatePlanSchema;
module.exports.DailyRateSchema = DailyRateSchema;
module.exports.SELL_MODES = SELL_MODES;
module.exports.RATE_MODES = RATE_MODES;
