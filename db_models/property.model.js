const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const PropertyInfoSchema = new mongoose.Schema(
  {
    hotel_name: {
      type: String,
      required: [true, "Hotel name is required."],
      trim: true,
      minlength: [2, "Hotel name must contain at least 2 characters."],
      maxlength: [180, "Hotel name cannot exceed 180 characters."]
    },
    pms_name: {
      type: String,
      required: [true, "PMS display name is required."],
      trim: true,
      minlength: [2, "PMS display name must contain at least 2 characters."],
      maxlength: [80, "PMS display name cannot exceed 80 characters."],
      default: "StayPilot"
    },
    hotel_type: {
      type: String,
      trim: true,
      maxlength: [80, "Hotel type cannot exceed 80 characters."],
      default: "Hotel"
    },
    hotel_guid: {
      type: String,
      trim: true,
      maxlength: [100, "Hotel GUID cannot exceed 100 characters."],
      default: () => crypto.randomUUID()
    },
    star_category: {
      type: Number,
      min: [0, "Star category cannot be below 0."],
      max: [5, "Star category cannot exceed 5."],
      default: 0
    },
    on_trial: { type: Boolean, default: false },
    plan: {
      type: String,
      trim: true,
      maxlength: [100, "Plan cannot exceed 100 characters."],
      default: ""
    },
    description: {
      type: String,
      trim: true,
      maxlength: [5000, "Description cannot exceed 5000 characters."],
      default: ""
    },
    address: {
      type: String,
      required: [true, "Hotel address is required."],
      trim: true,
      maxlength: [500, "Address cannot exceed 500 characters."]
    },
    city: {
      type: String,
      trim: true,
      maxlength: [100, "City cannot exceed 100 characters."],
      default: ""
    },
    postal_code: {
      type: String,
      trim: true,
      maxlength: [20, "Postal code cannot exceed 20 characters."],
      default: ""
    },
    country_code: {
      type: String,
      required: [true, "Two-letter country code is required."],
      trim: true,
      uppercase: true,
      match: [/^[A-Z]{2}$/, "Country code must contain exactly 2 letters."]
    },
    phone: {
      type: String,
      trim: true,
      maxlength: [40, "Phone number cannot exceed 40 characters."],
      validate: {
        validator: isValidPhone,
        message: "Phone number must contain between 7 and 20 digits."
      },
      default: ""
    },
    email: {
      type: String,
      required: [true, "Hotel email is required."],
      trim: true,
      lowercase: true,
      maxlength: [254, "Email cannot exceed 254 characters."],
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Hotel email address is invalid."]
    },
    website: {
      type: String,
      trim: true,
      maxlength: [500, "Website URL cannot exceed 500 characters."],
      validate: {
        validator: isValidOptionalHttpUrl,
        message: "Website must be a valid HTTP or HTTPS URL."
      },
      default: ""
    },
    check_in_time: {
      type: String,
      required: [true, "Check-in time is required."],
      trim: true,
      match: [/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Check-in time must use HH:mm format."],
      default: "14:00"
    },
    check_out_time: {
      type: String,
      required: [true, "Check-out time is required."],
      trim: true,
      match: [/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Check-out time must use HH:mm format."],
      default: "11:00"
    },
    home_currency: {
      type: String,
      required: [true, "Home currency is required."],
      trim: true,
      uppercase: true,
      match: [/^[A-Z]{3}$/, "Home currency must be a 3-letter currency code."],
      default: "LKR"
    },
    language_code: {
      type: String,
      required: [true, "Language code is required."],
      trim: true,
      uppercase: true,
      match: [/^[A-Z]{2,10}$/, "Language code must contain 2 to 10 letters."],
      default: "EN"
    },
    timezone: {
      type: String,
      required: [true, "Timezone is required."],
      trim: true,
      maxlength: [100, "Timezone cannot exceed 100 characters."],
      default: "Asia/Colombo"
    },
    invoice_footer: {
      type: String,
      trim: true,
      maxlength: [2000, "Invoice footer cannot exceed 2000 characters."],
      default: ""
    },
    invoice_notes: {
      type: String,
      trim: true,
      maxlength: [3000, "Invoice notes cannot exceed 3000 characters."],
      default: ""
    },
    cm_property_id: {
      type: String,
      trim: true,
      maxlength: [150, "Channel-manager property ID cannot exceed 150 characters."],
      default: ""
    },
    cm_active: { type: Boolean, default: false },
    latitude: {
      type: Number,
      min: [-90, "Latitude cannot be below -90."],
      max: [90, "Latitude cannot exceed 90."],
      default: null
    },
    longitude: {
      type: Number,
      min: [-180, "Longitude cannot be below -180."],
      max: [180, "Longitude cannot exceed 180."],
      default: null
    },
    ibe_logo_width: {
      type: Number,
      min: [1, "IBE logo width must be at least 1 pixel."],
      max: [5000, "IBE logo width cannot exceed 5000 pixels."],
      default: 400
    },
    ibe_logo_height: {
      type: Number,
      min: [1, "IBE logo height must be at least 1 pixel."],
      max: [5000, "IBE logo height cannot exceed 5000 pixels."],
      default: 200
    }
  },
  { _id: false }
);

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function themeColor(defaultColor) {
  return {
    type: String,
    trim: true,
    match: [HEX_COLOR_PATTERN, "Theme colors must use the #RRGGBB format."],
    default: defaultColor
  };
}

const ReservationStatusColorsSchema = new mongoose.Schema(
  {
    confirmed: themeColor("#10b981"),
    tentative: themeColor("#f59e0b"),
    checked_out: themeColor("#ef4444"),
    checked_in: themeColor("#06b6d4"),
    cancelled: themeColor("#6b7280"),
    no_show: themeColor("#78716c"),
    no_show_surcharge: themeColor("#57534e"),
    blocked: themeColor("#a855f7"),
    out_of_order: themeColor("#1f2937"),
    invalid_card: themeColor("#be185d")
  },
  { _id: false }
);

const PropertyThemeSchema = new mongoose.Schema(
  {
    accent_color: themeColor("#3b82f6"),
    reservation_status_colors: {
      type: ReservationStatusColorsSchema,
      default: () => ({})
    }
  },
  { _id: false }
);

const PropertySchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      minlength: [2, "Property ID must contain at least 2 characters."],
      maxlength: [100, "Property ID cannot exceed 100 characters."],
      match: [
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
        "Property ID may contain only letters, numbers, hyphens and underscores."
      ],
      unique: true,
      index: true,
      immutable: true
    },
    info: {
      type: PropertyInfoSchema,
      required: [true, "Property information is required."]
    },
    theme: {
      type: PropertyThemeSchema,
      default: () => ({})
    },
    status: {
      type: String,
      enum: {
        values: ["active", "inactive"],
        message: "Property status must be active or inactive."
      },
      default: "active",
      index: true
    },
    business_date: {
      type: Date,
      required: false,
      index: true
    },
    created_by: { type: ActorSchema, default: () => ({}) },
    updated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    versionKey: "version",
    collection: "properties",
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

const PropertyImageSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: [100, "Property ID cannot exceed 100 characters."],
      index: true
    },
    file_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, "Stored image file ID is required."],
      unique: true,
      index: true
    },
    image_type: {
      type: String,
      enum: { values: ["logo", "gallery"], message: "Image type must be logo or gallery." },
      required: [true, "Image type is required."],
      index: true
    },
    filename: {
      type: String,
      required: [true, "Image filename is required."],
      trim: true,
      maxlength: [255, "Image filename cannot exceed 255 characters."]
    },
    content_type: {
      type: String,
      required: [true, "Image content type is required."],
      enum: ["image/jpeg", "image/png", "image/webp"]
    },
    size: {
      type: Number,
      required: [true, "Image size is required."],
      min: [1, "Image cannot be empty."]
    },
    alt_text: { type: String, trim: true, maxlength: 250, default: "" },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    is_primary: { type: Boolean, default: false, index: true },
    sort_order: { type: Number, min: 0, default: 0 },
    created_by: { type: ActorSchema, default: () => ({}) },
    updated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    versionKey: "version",
    collection: "property_images",
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

const MealAmountSchema = new mongoose.Schema(
  {
    breakfast: { type: Number, min: [0, "Breakfast allocation cannot be negative."], default: 0 },
    lunch: { type: Number, min: [0, "Lunch allocation cannot be negative."], default: 0 },
    dinner: { type: Number, min: [0, "Dinner allocation cannot be negative."], default: 0 }
  },
  { _id: false }
);

const MEAL_PLANS = [
  "Room Only",
  "Bed & Breakfast",
  "Half Board",
  "Full Board",
  "All Inclusive"
];

const MealAllocationSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: [100, "Property ID cannot exceed 100 characters."],
      index: true
    },
    name: {
      type: String,
      required: [true, "Allocation name is required."],
      trim: true,
      minlength: [2, "Allocation name must contain at least 2 characters."],
      maxlength: [120, "Allocation name cannot exceed 120 characters."]
    },
    meal_plan: {
      type: String,
      required: [true, "Meal plan is required."],
      enum: { values: MEAL_PLANS, message: "Meal plan is not supported." },
      index: true
    },
    currency: {
      type: String,
      required: [true, "Currency is required."],
      trim: true,
      uppercase: true,
      match: [/^[A-Z]{3}$/, "Currency must be a 3-letter currency code."]
    },
    adult_amounts: { type: MealAmountSchema, default: () => ({}) },
    child_amounts: { type: MealAmountSchema, default: () => ({}) },
    valid_from: { type: Date, required: [true, "Valid-from date is required."], index: true },
    valid_to: { type: Date, required: [true, "Valid-to date is required."], index: true },
    active: { type: Boolean, default: true, index: true },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    created_by: { type: ActorSchema, default: () => ({}) },
    updated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    versionKey: "version",
    collection: "meal_allocations",
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

MealAllocationSchema.index({ property_id: 1, meal_plan: 1, valid_from: 1, valid_to: 1 });
MealAllocationSchema.index({ property_id: 1, active: 1, valid_from: 1 });

MealAllocationSchema.pre("validate", function normalizeMealAllocation() {
  this.property_id = String(this.property_id || "").trim();
  this.name = collapseWhitespace(this.name);
  this.currency = String(this.currency || "").trim().toUpperCase();
  this.valid_from = dateOnly(this.valid_from);
  this.valid_to = dateOnly(this.valid_to);

  if (this.valid_from && this.valid_to && this.valid_to < this.valid_from) {
    this.invalidate("valid_to", "Valid-to date cannot be before valid-from date.");
  }

  const allowedMeals = mealsForPlan(this.meal_plan);
  for (const audience of ["adult_amounts", "child_amounts"]) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      if (!allowedMeals.has(meal) && Number(this[audience]?.[meal] || 0) !== 0) {
        this.invalidate(
          `${audience}.${meal}`,
          `${capitalize(meal)} is not included in the ${this.meal_plan} meal plan.`
        );
      }
    }
  }
});

PropertyImageSchema.index(
  { property_id: 1, image_type: 1 },
  {
    unique: true,
    partialFilterExpression: { image_type: "logo" },
    name: "one_official_logo_per_property"
  }
);
PropertyImageSchema.index({ property_id: 1, image_type: 1, is_primary: 1, sort_order: 1 });

PropertySchema.pre("validate", function normalizeProperty() {
  this.property_id = String(this.property_id || "").trim();
  if (!this.info) return;
  this.info.hotel_name = collapseWhitespace(this.info.hotel_name);
  this.info.pms_name = collapseWhitespace(this.info.pms_name);
  this.info.hotel_type = collapseWhitespace(this.info.hotel_type);
  this.info.city = collapseWhitespace(this.info.city);
  this.info.country_code = String(this.info.country_code || "").trim().toUpperCase();
  this.info.home_currency = String(this.info.home_currency || "").trim().toUpperCase();
  this.info.language_code = String(this.info.language_code || "").trim().toUpperCase();
  this.info.email = String(this.info.email || "").trim().toLowerCase();
});

function isValidPhone(value) {
  if (!value) return true;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 20;
}

function isValidOptionalHttpUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const Property =
  mongoose.models.Property ||
  mongoose.model("Property", PropertySchema, "properties");

const PropertyImage =
  mongoose.models.PropertyImage ||
  mongoose.model("PropertyImage", PropertyImageSchema, "property_images");

const MealAllocation =
  mongoose.models.MealAllocation ||
  mongoose.model("MealAllocation", MealAllocationSchema, "meal_allocations");

function mealsForPlan(mealPlan) {
  if (mealPlan === "Bed & Breakfast") return new Set(["breakfast"]);
  if (mealPlan === "Half Board") return new Set(["breakfast", "dinner"]);
  if (["Full Board", "All Inclusive"].includes(mealPlan)) {
    return new Set(["breakfast", "lunch", "dinner"]);
  }
  return new Set();
}

function dateOnly(value) {
  if (!value) return value;
  const parsed = value instanceof Date ? value : new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

module.exports = Property;
module.exports.PropertyImage = PropertyImage;
module.exports.MealAllocation = MealAllocation;
module.exports.PropertySchema = PropertySchema;
module.exports.PropertyInfoSchema = PropertyInfoSchema;
module.exports.PropertyThemeSchema = PropertyThemeSchema;
module.exports.ReservationStatusColorsSchema = ReservationStatusColorsSchema;
module.exports.PropertyImageSchema = PropertyImageSchema;
module.exports.MealAllocationSchema = MealAllocationSchema;
module.exports.MEAL_PLANS = MEAL_PLANS;
