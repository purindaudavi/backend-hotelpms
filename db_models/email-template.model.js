const mongoose = require("mongoose");
const { ActorSchema } = require("./booking.model");

const EMAIL_CATEGORIES = [
  "confirmation",
  "check-in",
  "check-out",
  "cancellation",
  "reminder",
  "no-show",
  "general"
];

const EmailTemplateBlockSchema = new mongoose.Schema(
  {
    block_id: { type: String, required: true, trim: true, maxlength: 120 },
    kind: { type: String, required: true, enum: ["header", "reservation", "custom", "footer"] },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    content: { type: String, required: true, maxlength: 12000 }
  },
  { _id: false }
);

const EmailTemplateSchema = new mongoose.Schema(
  {
    property_id: { type: String, required: true, trim: true, maxlength: 100, index: true },
    category: { type: String, required: true, enum: EMAIL_CATEGORIES, index: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    subject: { type: String, required: true, trim: true, maxlength: 300 },
    blocks: {
      type: [EmailTemplateBlockSchema],
      required: true,
      validate: {
        validator: (blocks) => Array.isArray(blocks) && blocks.length > 0 && blocks.length <= 30,
        message: "Email templates require between 1 and 30 blocks."
      }
    },
    active: { type: Boolean, default: false, index: true },
    created_by: { type: ActorSchema, default: () => ({}) },
    updated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
  }
);

EmailTemplateSchema.index({ property_id: 1, category: 1, name: 1 }, { unique: true });
EmailTemplateSchema.index({ property_id: 1, category: 1, active: 1 });

EmailTemplateSchema.pre("validate", function normalizeTemplate() {
  this.property_id = String(this.property_id || "").trim();
  this.category = String(this.category || "").trim().toLowerCase();
  this.name = String(this.name || "").replace(/\s+/g, " ").trim();
  this.subject = String(this.subject || "").replace(/[\r\n]+/g, " ").trim();
});

const EmailTemplateSettingsSchema = new mongoose.Schema(
  {
    property_id: { type: String, required: true, trim: true, maxlength: 100, unique: true, index: true },
    use_default_templates: { type: Boolean, default: true },
    updated_by: { type: ActorSchema, default: () => ({}) }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
  }
);

const EmailTemplate = mongoose.models.EmailTemplate || mongoose.model(
  "EmailTemplate",
  EmailTemplateSchema,
  "email_templates"
);
const EmailTemplateSettings = mongoose.models.EmailTemplateSettings || mongoose.model(
  "EmailTemplateSettings",
  EmailTemplateSettingsSchema,
  "email_template_settings"
);

module.exports = EmailTemplate;
module.exports.EmailTemplate = EmailTemplate;
module.exports.EmailTemplateSettings = EmailTemplateSettings;
module.exports.EmailTemplateSchema = EmailTemplateSchema;
module.exports.EMAIL_CATEGORIES = EMAIL_CATEGORIES;
