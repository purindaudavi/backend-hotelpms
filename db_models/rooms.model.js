const mongoose = require("mongoose");

const OPERATIONAL_STATUSES = [
  "available",
  "occupied",
  "out_of_order",
  "maintenance"
];

const HOUSEKEEPING_STATUSES = [
  "clean",
  "dirty",
  "inspected",
  "in_progress"
];

const RoomImageSchema = new mongoose.Schema(
  {
    file_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    filename: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255
    },
    content_type: {
      type: String,
      required: true,
      enum: ["image/jpeg", "image/png", "image/webp"]
    },
    size: {
      type: Number,
      required: true,
      min: 1
    },
    alt_text: {
      type: String,
      trim: true,
      maxlength: 250,
      default: ""
    },
    is_primary: {
      type: Boolean,
      default: false
    }
  },
  {
    _id: true,
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
  }
);

const PhysicalRoomSchema = new mongoose.Schema(
  {
    room_number: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30
    },
    floor: {
      type: String,
      trim: true,
      maxlength: 50,
      default: ""
    },
    operational_status: {
      type: String,
      enum: OPERATIONAL_STATUSES,
      default: "available",
      index: true
    },
    housekeeping_status: {
      type: String,
      enum: HOUSEKEEPING_STATUSES,
      default: "clean",
      index: true
    },
    active: {
      type: Boolean,
      default: true,
      index: true
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ""
    }
  },
  {
    _id: true,
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
  }
);

const RoomTypeSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    maximum_adults: {
      type: Number,
      required: true,
      min: 1,
      max: 30,
      default: 2
    },
    maximum_children: {
      type: Number,
      required: true,
      min: 0,
      max: 30,
      default: 0
    },
    included_adults: {
      type: Number,
      required: true,
      min: 1,
      max: 30,
      default: 1
    },
    included_children: {
      type: Number,
      required: true,
      min: 0,
      max: 30,
      default: 0
    },
    extra_adult_rate: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    extra_child_rate: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    base_rate: {
      type: Number,
      required: true,
      min: 0
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      default: "LKR"
    },
    description: {
      type: String,
      trim: true,
      maxlength: 3000,
      default: ""
    },
    amenities: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: 100
        }
      ],
      default: []
    },
    physical_rooms: {
      type: [PhysicalRoomSchema],
      default: []
    },
    images: {
      type: [RoomImageSchema],
      default: []
    },
    active: {
      type: Boolean,
      default: true,
      index: true
    }
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

RoomTypeSchema.virtual("physical_room_count").get(function getPhysicalRoomCount() {
  return this.physical_rooms.length;
});

RoomTypeSchema.index(
  { property_id: 1, slug: 1 },
  { unique: true, name: "unique_room_type_name_per_property" }
);

RoomTypeSchema.index(
  { property_id: 1, "physical_rooms.room_number": 1 },
  {
    unique: true,
    sparse: true,
    name: "unique_physical_room_number_per_property"
  }
);

RoomTypeSchema.index({
  property_id: 1,
  active: 1,
  "physical_rooms.operational_status": 1,
  "physical_rooms.housekeeping_status": 1
});

RoomTypeSchema.pre("validate", function normalizeAndValidateRoomType() {
  if (this.isModified("name") || !this.slug) {
    this.slug = slugify(this.name);
  }

  this.amenities = Array.from(
    new Set(
      this.amenities
        .map((amenity) => String(amenity).trim())
        .filter(Boolean)
    )
  );

  if (this.included_adults > this.maximum_adults) {
    this.invalidate(
      "included_adults",
      "Adults included in the base rate cannot exceed maximum adults."
    );
  }
  if (this.included_children > this.maximum_children) {
    this.invalidate(
      "included_children",
      "Children included in the base rate cannot exceed maximum children."
    );
  }

  const normalizedRoomNumbers = this.physical_rooms.map((room) =>
    room.room_number.trim().toLowerCase()
  );
  if (new Set(normalizedRoomNumbers).size !== normalizedRoomNumbers.length) {
    this.invalidate(
      "physical_rooms",
      "Physical room numbers must be unique inside a room type."
    );
  }

  if (this.images.length > 8) {
    this.invalidate("images", "A room type can contain at most 8 shared images.");
  }

  const primaryImages = this.images.filter((image) => image.is_primary);
  if (primaryImages.length > 1) {
    this.invalidate("images", "Only one shared image can be marked as primary.");
  }
});

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const RoomType =
  mongoose.models.RoomType ||
  mongoose.model("RoomType", RoomTypeSchema, "room_types");

module.exports = RoomType;
module.exports.OPERATIONAL_STATUSES = OPERATIONAL_STATUSES;
module.exports.HOUSEKEEPING_STATUSES = HOUSEKEEPING_STATUSES;
