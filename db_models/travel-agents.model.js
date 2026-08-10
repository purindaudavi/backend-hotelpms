const mongoose = require("mongoose");

const AGENT_TYPES = [
  "online_travel_agent",
  "traditional_agent",
  "corporate",
  "tour_operator"
];

const AGENT_STATUSES = ["active", "inactive"];

const TravelAgentSchema = new mongoose.Schema(
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
      required: [true, "Travel-agent name is required."],
      trim: true,
      minlength: [2, "Travel-agent name must contain at least 2 characters."],
      maxlength: [150, "Travel-agent name cannot exceed 150 characters."]
    },
    code: {
      type: String,
      required: [true, "Travel-agent code is required."],
      trim: true,
      uppercase: true,
      minlength: [2, "Travel-agent code must contain at least 2 characters."],
      maxlength: [40, "Travel-agent code cannot exceed 40 characters."],
      match: [/^[A-Z0-9][A-Z0-9_-]*$/, "Travel-agent code may only contain letters, numbers, hyphens and underscores."]
    },
    contact_person: {
      type: String,
      trim: true,
      maxlength: [150, "Contact-person name cannot exceed 150 characters."],
      default: ""
    },
    agent_type: {
      type: String,
      enum: {
        values: AGENT_TYPES,
        message: "Agent type is invalid."
      },
      required: [true, "Agent type is required."],
      default: "traditional_agent",
      index: true
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [254, "Email cannot exceed 254 characters."],
      validate: {
        validator: (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        message: "Travel-agent email address is invalid."
      },
      default: ""
    },
    phone: {
      type: String,
      trim: true,
      maxlength: [40, "Phone number cannot exceed 40 characters."],
      validate: {
        validator: isValidOptionalPhone,
        message: "Travel-agent phone number must contain between 7 and 20 digits."
      },
      default: ""
    },
    commission_percentage: {
      type: Number,
      required: true,
      min: [0, "Commission percentage cannot be negative."],
      max: [100, "Commission percentage cannot exceed 100."],
      default: 0
    },
    address: {
      type: String,
      trim: true,
      maxlength: [500, "Address cannot exceed 500 characters."],
      default: ""
    },
    vat_number: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [80, "VAT number cannot exceed 80 characters."],
      default: ""
    },
    status: {
      type: String,
      enum: {
        values: AGENT_STATUSES,
        message: "Travel-agent status must be active or inactive."
      },
      default: "active",
      index: true
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [2000, "Notes cannot exceed 2,000 characters."],
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

TravelAgentSchema.index(
  { property_id: 1, code: 1 },
  { unique: true, name: "unique_travel_agent_code_per_property" }
);
TravelAgentSchema.index({ property_id: 1, status: 1, name: 1 });
TravelAgentSchema.index({ property_id: 1, agent_type: 1, name: 1 });

TravelAgentSchema.pre("validate", function normalizeTravelAgent() {
  this.property_id = normalizeSpaces(this.property_id);
  this.name = normalizeSpaces(this.name);
  this.code = normalizeSpaces(this.code).toUpperCase();
  this.contact_person = normalizeSpaces(this.contact_person);
  this.agent_type = normalizeAgentType(this.agent_type);
  this.email = normalizeSpaces(this.email).toLowerCase();
  this.phone = normalizeSpaces(this.phone);
  this.address = normalizeSpaces(this.address);
  this.vat_number = normalizeSpaces(this.vat_number).toUpperCase();
  this.status = normalizeSpaces(this.status).toLowerCase();
  this.notes = typeof this.notes === "string" ? this.notes.trim() : this.notes;
});

function normalizeAgentType(value) {
  const normalized = normalizeSpaces(value)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const aliases = {
    ota: "online_travel_agent",
    travel_agent: "traditional_agent"
  };
  return aliases[normalized] || normalized;
}

function normalizeSpaces(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
}

function isValidOptionalPhone(value) {
  if (!value) return true;
  if (!/^[+\d\s().-]+$/.test(value)) return false;
  const digitCount = (value.match(/\d/g) || []).length;
  return digitCount >= 7 && digitCount <= 20;
}

const TravelAgent =
  mongoose.models.TravelAgent ||
  mongoose.model("TravelAgent", TravelAgentSchema, "travel_agents");

module.exports = TravelAgent;
module.exports.TravelAgentSchema = TravelAgentSchema;
module.exports.AGENT_TYPES = AGENT_TYPES;
module.exports.AGENT_STATUSES = AGENT_STATUSES;
