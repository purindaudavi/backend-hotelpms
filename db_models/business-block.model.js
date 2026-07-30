const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const BUSINESS_BLOCK_STATUSES = [
  "tentative",
  "active",
  "released",
  "cancelled",
  "completed"
];

const AllocationSchema = new mongoose.Schema(
  {
    room_type_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: [true, "Room type ID is required."]
    },
    room_type_name: {
      type: String,
      required: [true, "Room type name is required."],
      trim: true,
      maxlength: 120
    },
    quantity: { type: Number, required: true, min: 1, max: 1000 },
    rate_plan_id: { type: String, trim: true, maxlength: 120, default: "" },
    rate_plan_name: { type: String, trim: true, maxlength: 150, default: "" },
    meal_plan: { type: String, trim: true, maxlength: 100, default: "" },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      default: "LKR"
    },
    negotiated_rate: { type: Number, required: true, min: 0, default: 0 },
    tax_inclusive: { type: Boolean, default: false },
    is_complimentary: { type: Boolean, default: false },
    complimentary_reason: { type: String, trim: true, maxlength: 500, default: "" },
    released_quantity: { type: Number, min: 0, default: 0 }
  },
  { _id: true, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

AllocationSchema.pre("validate", function validateAllocation() {
  this.currency = String(this.currency || "LKR").trim().toUpperCase();
  if (this.released_quantity > this.quantity) {
    this.invalidate(
      "released_quantity",
      "Released quantity cannot exceed blocked quantity."
    );
  }
  if (this.is_complimentary && !this.complimentary_reason) {
    this.invalidate(
      "complimentary_reason",
      "A complimentary allocation requires a reason."
    );
  }
});

const ContactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 150, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" }
  },
  { _id: false }
);

const BillingSchema = new mongoose.Schema(
  {
    payment_method: { type: String, trim: true, maxlength: 100, default: "" },
    billing_party: {
      type: String,
      enum: ["company", "guest", "travel_agent", "split"],
      default: "company"
    },
    deposit_required: { type: Number, min: 0, default: 0 },
    deposit_paid: { type: Number, min: 0, default: 0 },
    payment_due_date: { type: Date, required: false },
    remarks: { type: String, trim: true, maxlength: 3000, default: "" }
  },
  { _id: false }
);

const BusinessBlockSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    block_number: {
      type: String,
      required: [true, "Block number is required."],
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    block_name: {
      type: String,
      required: [true, "Block name is required."],
      trim: true,
      maxlength: 150
    },
    company_name: {
      type: String,
      required: [true, "Company name is required."],
      trim: true,
      maxlength: 150
    },
    contact: { type: ContactSchema, default: () => ({}) },
    check_in: { type: Date, required: true, index: true },
    check_out: { type: Date, required: true, index: true },
    cutoff_date: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: BUSINESS_BLOCK_STATUSES,
      default: "tentative",
      index: true
    },
    allocations: {
      type: [AllocationSchema],
      required: true,
      validate: {
        validator: (allocations) => Array.isArray(allocations) && allocations.length > 0,
        message: "At least one room allocation is required."
      }
    },
    billing: { type: BillingSchema, default: () => ({}) },
    cancellation_policy: { type: String, trim: true, maxlength: 3000, default: "" },
    block_remarks: { type: String, trim: true, maxlength: 3000, default: "" },
    internal_remarks: { type: String, trim: true, maxlength: 3000, default: "" },
    special_requirements: { type: String, trim: true, maxlength: 3000, default: "" },
    created_by: { type: ActorSchema, default: () => ({}) },
    updated_by: { type: ActorSchema, default: () => ({}) },
    deleted_at: { type: Date, required: false, index: true },
    deleted_by: { type: ActorSchema, required: false }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    toJSON: {
      virtuals: true,
      transform(_document, result) {
        result.version = result.__v;
        delete result.__v;
        return result;
      }
    },
    toObject: { virtuals: true }
  }
);

BusinessBlockSchema.virtual("nights").get(function getNights() {
  return Math.max(0, Math.ceil((this.check_out - this.check_in) / 86_400_000));
});

BusinessBlockSchema.index(
  { property_id: 1, block_number: 1 },
  { unique: true, name: "unique_business_block_number_per_property" }
);
BusinessBlockSchema.index({ property_id: 1, status: 1, check_in: 1, check_out: 1 });
BusinessBlockSchema.index({ property_id: 1, cutoff_date: 1, status: 1 });
BusinessBlockSchema.index({ property_id: 1, "allocations.room_type_id": 1 });

BusinessBlockSchema.pre("validate", function validateBusinessBlock() {
  this.block_number = String(this.block_number || "").trim().toUpperCase();
  this.block_name = collapseWhitespace(this.block_name);
  this.company_name = collapseWhitespace(this.company_name);

  if (this.check_out <= this.check_in) {
    this.invalidate("check_out", "Business block check-out must be after check-in.");
  }
  if (this.cutoff_date > this.check_in) {
    this.invalidate("cutoff_date", "Cut-off date cannot be after check-in.");
  }
  if (
    this.billing.deposit_required > 0 &&
    this.billing.deposit_paid > this.billing.deposit_required
  ) {
    this.invalidate(
      "billing.deposit_paid",
      "Deposit paid cannot exceed deposit required."
    );
  }

  const roomTypeIds = this.allocations.map((allocation) =>
    String(allocation.room_type_id)
  );
  if (new Set(roomTypeIds).size !== roomTypeIds.length) {
    this.invalidate(
      "allocations",
      "A room type can appear only once in a business block."
    );
  }
});

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const BusinessBlock =
  mongoose.models.BusinessBlock ||
  mongoose.model("BusinessBlock", BusinessBlockSchema, "business_blocks");

module.exports = BusinessBlock;
module.exports.BUSINESS_BLOCK_STATUSES = BUSINESS_BLOCK_STATUSES;
