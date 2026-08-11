const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const AttendantSnapshotSchema = new mongoose.Schema(
  {
    attendant_id: { type: mongoose.Schema.Types.ObjectId, required: false },
    employee_number: { type: String, trim: true, maxlength: 50, default: "" },
    name: { type: String, trim: true, maxlength: 150, default: "" }
  },
  { _id: false }
);

const HousekeepingTaskSchema = new mongoose.Schema(
  {
    property_id: { type: String, required: true, trim: true, maxlength: 100, index: true },
    physical_room_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    room_type_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    room_number: { type: String, required: true, trim: true, maxlength: 30 },
    room_type_name: { type: String, required: true, trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ["assigned", "in_progress", "completed", "inspected"],
      default: "assigned",
      index: true
    },
    priority: {
      type: String,
      enum: ["low", "normal", "high", "urgent"],
      default: "normal",
      index: true
    },
    attendant: { type: AttendantSnapshotSchema, default: () => ({}) },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    assigned_at: { type: Date, default: null },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    inspected_at: { type: Date, default: null },
    updated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    versionKey: "version",
    collection: "housekeeping_tasks"
  }
);

HousekeepingTaskSchema.index(
  { property_id: 1, physical_room_id: 1 },
  { unique: true }
);
HousekeepingTaskSchema.index({ property_id: 1, status: 1, priority: 1, updated_at: -1 });

const HousekeepingAttendantSchema = new mongoose.Schema(
  {
    property_id: { type: String, required: true, trim: true, maxlength: 100, index: true },
    employee_number: { type: String, required: true, trim: true, uppercase: true, maxlength: 50 },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    department: { type: String, trim: true, maxlength: 100, default: "Housekeeping" },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    joined_at: { type: Date, default: Date.now },
    updated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    optimisticConcurrency: true,
    versionKey: "version",
    collection: "housekeeping_attendants"
  }
);

HousekeepingAttendantSchema.index(
  { property_id: 1, employee_number: 1 },
  { unique: true }
);

HousekeepingAttendantSchema.pre("validate", function normalizeAttendant() {
  if (this.email && !/^\S+@\S+\.\S+$/.test(this.email)) {
    this.invalidate("email", "Email must be valid.");
  }
});

const HousekeepingActivitySchema = new mongoose.Schema(
  {
    property_id: { type: String, required: true, trim: true, maxlength: 100, index: true },
    physical_room_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    room_type_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    task_id: { type: mongoose.Schema.Types.ObjectId, required: false, index: true },
    room_number: { type: String, required: true, trim: true, maxlength: 30 },
    room_type_name: { type: String, required: true, trim: true, maxlength: 120 },
    action: {
      type: String,
      enum: ["room_marked_dirty", "assigned", "cleaning_started", "cleaning_completed", "inspection_completed"],
      required: true,
      index: true
    },
    from_status: { type: String, trim: true, maxlength: 40, default: "" },
    to_status: { type: String, trim: true, maxlength: 40, default: "" },
    attendant: { type: AttendantSnapshotSchema, default: () => ({}) },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    actor: { type: ActorSchema, default: () => ({}) },
    request_id: { type: String, trim: true, maxlength: 150, default: "" },
    created_at: { type: Date, required: true, default: Date.now, immutable: true }
  },
  { versionKey: false, timestamps: false, collection: "housekeeping_activities" }
);

HousekeepingActivitySchema.index({ property_id: 1, created_at: -1 });
HousekeepingActivitySchema.index({ property_id: 1, physical_room_id: 1, created_at: -1 });

const HousekeepingTask =
  mongoose.models.HousekeepingTask || mongoose.model("HousekeepingTask", HousekeepingTaskSchema);
const HousekeepingAttendant =
  mongoose.models.HousekeepingAttendant || mongoose.model("HousekeepingAttendant", HousekeepingAttendantSchema);
const HousekeepingActivity =
  mongoose.models.HousekeepingActivity || mongoose.model("HousekeepingActivity", HousekeepingActivitySchema);

module.exports = {
  HousekeepingTask,
  HousekeepingAttendant,
  HousekeepingActivity,
  HousekeepingTaskSchema,
  HousekeepingAttendantSchema,
  HousekeepingActivitySchema
};
