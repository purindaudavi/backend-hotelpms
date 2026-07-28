const mongoose = require("mongoose");

const GuestSchema = new mongoose.Schema(
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
      required: [true, "Guest name is required."],
      trim: true,
      minlength: [2, "Guest name must contain at least 2 characters."],
      maxlength: [150, "Guest name cannot exceed 150 characters."]
    },
    phone: {
      type: String,
      required: [true, "Guest phone number is required."],
      trim: true,
      maxlength: [40, "Guest phone number cannot exceed 40 characters."],
      validate: {
        validator: isValidPhone,
        message: "Guest phone number must contain between 7 and 20 digits."
      }
    },
    country: {
      type: String,
      required: [true, "Guest country is required."],
      trim: true,
      minlength: [2, "Guest country must contain at least 2 characters."],
      maxlength: [100, "Guest country cannot exceed 100 characters."],
      index: true
    },
    email: {
      type: String,
      required: [true, "Guest email is required."],
      trim: true,
      lowercase: true,
      maxlength: [254, "Guest email cannot exceed 254 characters."],
      validate: {
        validator: isValidEmail,
        message: "Guest email address is invalid."
      }
    }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    toJSON: {
      transform(_document, result) {
        delete result.__v;
        return result;
      }
    }
  }
);

GuestSchema.index(
  { property_id: 1, email: 1 },
  { unique: true, name: "unique_guest_email_per_property" }
);

GuestSchema.index({ property_id: 1, name: 1 });
GuestSchema.index({ property_id: 1, phone: 1 });
GuestSchema.index({ property_id: 1, country: 1, name: 1 });

GuestSchema.pre("validate", function normalizeGuest() {
  if (typeof this.name === "string") {
    this.name = this.name.replace(/\s+/g, " ").trim();
  }
  if (typeof this.phone === "string") {
    this.phone = this.phone.replace(/\s+/g, " ").trim();
  }
  if (typeof this.country === "string") {
    this.country = this.country.replace(/\s+/g, " ").trim();
  }
  if (typeof this.email === "string") {
    this.email = this.email.trim().toLowerCase();
  }
});

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function isValidPhone(value) {
  const phone = String(value || "");
  if (!/^[+\d\s().-]+$/.test(phone)) return false;
  const digitCount = (phone.match(/\d/g) || []).length;
  return digitCount >= 7 && digitCount <= 20;
}

const Guest =
  mongoose.models.Guest ||
  mongoose.model("Guest", GuestSchema, "guests");

module.exports = Guest;
