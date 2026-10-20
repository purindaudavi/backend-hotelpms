const mongoose = require("mongoose");

// One permanent coordination document per property. The built-in unique _id
// index is the lock key; no TTL or application-server-local mutex is involved.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  revision: { type: Number, required: true, default: 0 }
}, { versionKey: false });

module.exports = mongoose.models.InventoryGuard ||
  mongoose.model("InventoryGuard", schema, "inventory_guards");
