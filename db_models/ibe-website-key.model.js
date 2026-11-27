const mongoose = require("mongoose");

// One website credential per property. Replacing this document's credential
// atomically invalidates the previous key, including across server instances.
const schema = new mongoose.Schema({
  _id: { type: String, required: true, maxlength: 100 },
  key_id: { type: String, required: true, match: /^[a-f0-9]{24}$/ },
  key_hash: { type: String, required: true, select: false, match: /^[a-f0-9]{64}$/ },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  website_origin: { type: String, required: true, maxlength: 300 },
  revoked_at: { type: Date, default: null },
  created_by: { type: mongoose.Schema.Types.ObjectId, required: true },
  created_at: { type: Date, required: true, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model("IbeWebsiteKey", schema, "ibe_website_keys");
