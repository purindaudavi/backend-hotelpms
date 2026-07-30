const mongoose = require("mongoose");

const RESERVATION_STATUSES = [
  "tentative",
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
  "blocked"
];

const ACTIVE_RESERVATION_STATUSES = [
  "tentative",
  "confirmed",
  "checked_in",
  "blocked"
];

const EMAIL_STATUSES = [
  "not_requested",
  "pending",
  "accepted",
  "sent",
  "failed"
];

const ActorSchema = new mongoose.Schema(
  {
    user_id: { type: String, trim: true, maxlength: 120, default: "" },
    name: { type: String, trim: true, maxlength: 150, default: "System" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" }
  },
  { _id: false }
);

const BookerSchema = new mongoose.Schema(
  {
    guest_profile_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: false
    },
    title: { type: String, trim: true, maxlength: 30, default: "" },
    name: {
      type: String,
      required: [true, "Booker name is required."],
      trim: true,
      maxlength: 150
    },
    phone: {
      type: String,
      required: [true, "Booker phone number is required."],
      trim: true,
      maxlength: 40
    },
    email: {
      type: String,
      required: [true, "Booker email is required."],
      trim: true,
      lowercase: true,
      maxlength: 254,
      validate: {
        validator: isValidEmail,
        message: "Booker email address is invalid."
      }
    },
    country: {
      type: String,
      required: [true, "Booker country is required."],
      trim: true,
      maxlength: 100
    }
  },
  { _id: false }
);

const TravelAgentSchema = new mongoose.Schema(
  {
    travel_agent_id: { type: String, trim: true, maxlength: 120, default: "" },
    name: { type: String, trim: true, maxlength: 150, default: "" },
    commission_percentage: { type: Number, min: 0, max: 100, default: 0 },
    commission_amount: { type: Number, min: 0, default: 0 }
  },
  { _id: false }
);

const ReservationRoomSchema = new mongoose.Schema(
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
    physical_room_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: false
    },
    room_number: { type: String, trim: true, maxlength: 30, default: "" },
    occupancy: { type: String, trim: true, maxlength: 50, default: "" },
    bed_type: { type: String, trim: true, maxlength: 80, default: "" },
    adults: { type: Number, required: true, min: 1, max: 30, default: 1 },
    children: { type: Number, required: true, min: 0, max: 30, default: 0 },
    rate_plan_id: { type: String, trim: true, maxlength: 120, default: "" },
    rate_plan_name: { type: String, trim: true, maxlength: 150, default: "" },
    meal_plan: { type: String, trim: true, maxlength: 100, default: "" },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      default: "LKR"
    },
    original_nightly_rate: { type: Number, min: 0, default: 0 },
    effective_nightly_rate: { type: Number, min: 0, default: 0 },
    is_complimentary: { type: Boolean, default: false },
    complimentary_reason: { type: String, trim: true, maxlength: 500, default: "" },
    requires_manager_approval: { type: Boolean, default: false },
    business_block_allocation_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: false
    }
  },
  { _id: true, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

ReservationRoomSchema.pre("validate", function validateComplimentaryRoom() {
  if (this.is_complimentary && !this.complimentary_reason) {
    this.invalidate(
      "complimentary_reason",
      "A complimentary room requires a reason."
    );
  }
});

const OccupantSchema = new mongoose.Schema(
  {
    room_line_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, "Reservation room line ID is required."]
    },
    guest_profile_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: false
    },
    title: { type: String, trim: true, maxlength: 30, default: "" },
    name: {
      type: String,
      required: [true, "Occupant name is required."],
      trim: true,
      maxlength: 150
    },
    guest_type: {
      type: String,
      enum: ["adult", "child"],
      default: "adult"
    },
    is_primary: { type: Boolean, default: false },
    is_main_booker: { type: Boolean, default: false },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    country: { type: String, trim: true, maxlength: 100, default: "" }
  },
  { _id: true, timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

const FinancialSummarySchema = new mongoose.Schema(
  {
    room_total: { type: Number, min: 0, default: 0 },
    tax_total: { type: Number, min: 0, default: 0 },
    discount_total: { type: Number, min: 0, default: 0 },
    extra_total: { type: Number, min: 0, default: 0 },
    grand_total: { type: Number, min: 0, default: 0 },
    paid_total: { type: Number, min: 0, default: 0 }
  },
  { _id: false }
);

const EmailDeliverySchema = new mongoose.Schema(
  {
    status: { type: String, enum: EMAIL_STATUSES, default: "not_requested" },
    last_category: { type: String, trim: true, maxlength: 50, default: "" },
    requested_at: { type: Date, required: false },
    sent_at: { type: Date, required: false },
    failure_message: { type: String, trim: true, maxlength: 1000, default: "" }
  },
  { _id: false }
);

const ReservationSchema = new mongoose.Schema(
  {
    property_id: {
      type: String,
      required: [true, "Property ID is required."],
      trim: true,
      maxlength: 100,
      index: true
    },
    reservation_no: {
      type: String,
      required: [true, "Reservation number is required."],
      trim: true,
      uppercase: true,
      maxlength: 50
    },
    booking_reference: { type: String, trim: true, maxlength: 120, default: "" },
    reservation_date: { type: Date, required: true, default: Date.now, index: true },
    check_in: { type: Date, required: [true, "Check-in date is required."], index: true },
    check_out: { type: Date, required: [true, "Check-out date is required."], index: true },
    is_day_room: { type: Boolean, default: false },
    status: {
      type: String,
      enum: RESERVATION_STATUSES,
      default: "confirmed",
      index: true
    },
    booking_source: {
      type: String,
      required: [true, "Booking source is required."],
      trim: true,
      maxlength: 100,
      default: "Direct"
    },
    tour_number: { type: String, trim: true, maxlength: 120, default: "" },
    group_name: { type: String, trim: true, maxlength: 150, default: "" },
    travel_agent: { type: TravelAgentSchema, default: () => ({}) },
    booker: { type: BookerSchema, required: true },
    rooms: {
      type: [ReservationRoomSchema],
      required: true,
      validate: {
        validator: (rooms) => Array.isArray(rooms) && rooms.length > 0,
        message: "At least one reservation room is required."
      }
    },
    occupants: { type: [OccupantSchema], default: [] },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      default: "LKR"
    },
    rate_plan_id: { type: String, trim: true, maxlength: 120, default: "" },
    rate_plan_name: { type: String, trim: true, maxlength: 150, default: "" },
    meal_plan: { type: String, trim: true, maxlength: 100, default: "" },
    refundable: { type: Boolean, default: true },
    cancellation_policy: { type: String, trim: true, maxlength: 3000, default: "" },
    financial_summary: { type: FinancialSummarySchema, default: () => ({}) },
    reservation_remarks: { type: String, trim: true, maxlength: 3000, default: "" },
    guest_remarks: { type: String, trim: true, maxlength: 3000, default: "" },
    internal_remarks: { type: String, trim: true, maxlength: 3000, default: "" },
    business_block_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessBlock",
      required: false,
      index: true
    },
    business_block_allocation_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: false
    },
    checked_in_at: { type: Date, required: false },
    checked_in_by: { type: ActorSchema, required: false },
    checked_out_at: { type: Date, required: false },
    checked_out_by: { type: ActorSchema, required: false },
    cancelled_at: { type: Date, required: false },
    cancelled_by: { type: ActorSchema, required: false },
    cancellation_reason: { type: String, trim: true, maxlength: 1000, default: "" },
    no_show_at: { type: Date, required: false },
    no_show_by: { type: ActorSchema, required: false },
    email_delivery: { type: EmailDeliverySchema, default: () => ({}) },
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

ReservationSchema.virtual("room_count").get(function getRoomCount() {
  return this.rooms.length;
});

ReservationSchema.virtual("nights").get(function getNights() {
  if (this.is_day_room) return 0;
  const milliseconds = this.check_out - this.check_in;
  return Math.max(0, Math.ceil(milliseconds / 86_400_000));
});

ReservationSchema.virtual("balance").get(function getBalance() {
  return Math.max(
    0,
    this.financial_summary.grand_total - this.financial_summary.paid_total
  );
});

ReservationSchema.index(
  { property_id: 1, reservation_no: 1 },
  { unique: true, name: "unique_reservation_number_per_property" }
);
ReservationSchema.index({ property_id: 1, status: 1, check_in: 1 });
ReservationSchema.index({ property_id: 1, check_in: 1, check_out: 1, status: 1 });
ReservationSchema.index({ property_id: 1, booking_reference: 1 });
ReservationSchema.index({ property_id: 1, "booker.email": 1 });
ReservationSchema.index({ property_id: 1, "booker.phone": 1 });
ReservationSchema.index({ property_id: 1, "travel_agent.travel_agent_id": 1 });
ReservationSchema.index({ property_id: 1, business_block_id: 1, status: 1 });
ReservationSchema.index({
  property_id: 1,
  "rooms.physical_room_id": 1,
  check_in: 1,
  check_out: 1,
  status: 1
});

ReservationSchema.pre("validate", function validateReservation() {
  normalizeReservation(this);

  if (this.is_day_room) {
    if (this.check_out < this.check_in) {
      this.invalidate("check_out", "Day-room check-out cannot be before check-in.");
    }
  } else if (this.check_out <= this.check_in) {
    this.invalidate("check_out", "Check-out must be after check-in.");
  }

  const roomIds = new Set(this.rooms.map((room) => String(room._id)));
  const primaryRooms = new Set();
  let mainBookerCount = 0;
  const occupantCounts = new Map();

  for (const occupant of this.occupants) {
    const roomId = String(occupant.room_line_id);
    if (!roomIds.has(roomId)) {
      this.invalidate(
        "occupants",
        `Occupant ${occupant.name} references a reservation room that does not exist.`
      );
      continue;
    }
    if (occupant.is_primary) {
      if (primaryRooms.has(roomId)) {
        this.invalidate("occupants", "Only one primary occupant is allowed per room.");
      }
      primaryRooms.add(roomId);
    }
    if (occupant.is_main_booker) mainBookerCount += 1;

    const counts = occupantCounts.get(roomId) || { adult: 0, child: 0 };
    counts[occupant.guest_type] += 1;
    occupantCounts.set(roomId, counts);
  }

  if (mainBookerCount > 1) {
    this.invalidate("occupants", "Only one main booker is allowed per reservation.");
  }

  for (const room of this.rooms) {
    const counts = occupantCounts.get(String(room._id));
    if (!counts) continue;
    if (counts.adult > room.adults || counts.child > room.children) {
      this.invalidate(
        "occupants",
        `The rooming list exceeds the reserved occupancy for ${room.room_type_name}.`
      );
    }
  }
});

function normalizeReservation(reservation) {
  reservation.reservation_no = String(reservation.reservation_no || "")
    .trim()
    .toUpperCase();
  reservation.booking_reference = String(reservation.booking_reference || "").trim();
  reservation.booking_source = collapseWhitespace(reservation.booking_source);
  reservation.tour_number = String(reservation.tour_number || "").trim();
  reservation.group_name = collapseWhitespace(reservation.group_name);
  reservation.currency = String(reservation.currency || "LKR").trim().toUpperCase();
  if (reservation.booker) {
    reservation.booker.name = collapseWhitespace(reservation.booker.name);
    reservation.booker.phone = String(reservation.booker.phone || "").trim();
    reservation.booker.email = String(reservation.booker.email || "")
      .trim()
      .toLowerCase();
    reservation.booker.country = collapseWhitespace(reservation.booker.country);
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const Reservation =
  mongoose.models.Reservation ||
  mongoose.model("Reservation", ReservationSchema, "reservations");

module.exports = Reservation;
module.exports.ReservationSchema = ReservationSchema;
module.exports.RESERVATION_STATUSES = RESERVATION_STATUSES;
module.exports.ACTIVE_RESERVATION_STATUSES = ACTIVE_RESERVATION_STATUSES;
module.exports.EMAIL_STATUSES = EMAIL_STATUSES;
module.exports.ActorSchema = ActorSchema;
