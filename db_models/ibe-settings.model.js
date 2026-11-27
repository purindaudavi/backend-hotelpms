const mongoose = require("mongoose");

// The property ID is the document ID, so concurrent first saves cannot create
// two settings documents for the same hotel.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  settings: { type: mongoose.Schema.Types.Mixed, required: true },
  version: { type: Number, required: true }
}, {
  timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  minimize: false,
  versionKey: false
});

module.exports = mongoose.model("IbeSettings", schema, "ibe_settings");
