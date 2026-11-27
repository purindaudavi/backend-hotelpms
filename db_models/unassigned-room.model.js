const mongoose = require("mongoose");
const { PhysicalRoomSchema } = require("./rooms.model");

// Assigned rooms remain in their existing room type. Only rooms without a type
// live here; transfers retain the original physical-room _id and all details.
const schema = PhysicalRoomSchema.clone();
schema.add({
  property_id: { type: String, required: true, trim: true, maxlength: 100, index: true },
  previous_room_type_id: { type: mongoose.Schema.Types.ObjectId, required: true }
});
schema.set("optimisticConcurrency", true);
schema.index({ property_id: 1, room_number: 1 }, { unique: true });

module.exports = mongoose.models.UnassignedRoom || mongoose.model("UnassignedRoom", schema, "unassigned_physical_rooms");
