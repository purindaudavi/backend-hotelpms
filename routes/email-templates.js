const express = require("express");
const mongoose = require("mongoose");
const EmailTemplate = require("../db_models/email-template.model");
const { EmailTemplateSettings, EMAIL_CATEGORIES } = require("../db_models/email-template.model");
const { actorFromRequest } = require("../services/booking-audit.service");
const { serializeDefaults, serializeTemplate } = require("../services/email-template.service");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const [templates, settings] = await Promise.all([
    EmailTemplate.find({ property_id: propertyId }).sort({ category: 1, updated_at: -1 }),
    EmailTemplateSettings.findOne({ property_id: propertyId })
  ]);
  return res.status(200).json({
    settings: { useDefaultTemplates: settings?.use_default_templates !== false },
    templates: templates.map(serializeTemplate),
    defaults: serializeDefaults()
  });
}));

router.patch("/settings", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  if (typeof req.body?.useDefaultTemplates !== "boolean") {
    throw httpError(400, "useDefaultTemplates must be true or false.");
  }
  const settings = await EmailTemplateSettings.findOneAndUpdate(
    { property_id: propertyId },
    {
      $set: {
        use_default_templates: req.body.useDefaultTemplates,
        updated_by: actorFromRequest(req)
      },
      $setOnInsert: { property_id: propertyId }
    },
    { new: true, upsert: true, runValidators: true }
  );
  return res.status(200).json({
    message: settings.use_default_templates ? "Default email templates enabled." : "Custom email templates enabled.",
    settings: { useDefaultTemplates: settings.use_default_templates }
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const template = await EmailTemplate.create({
    property_id: propertyId,
    ...templatePayload(req.body),
    active: false,
    created_by: actor,
    updated_by: actor
  });
  return res.status(201).json({ message: "Email template created.", template: serializeTemplate(template) });
}));

router.patch("/:templateId", asyncHandler(async (req, res) => {
  const template = await requireTemplate(req);
  const payload = templatePayload(req.body);
  template.category = payload.category;
  template.name = payload.name;
  template.subject = payload.subject;
  template.blocks = payload.blocks;
  template.updated_by = actorFromRequest(req);
  await template.save();
  return res.status(200).json({ message: "Email template updated.", template: serializeTemplate(template) });
}));

router.post("/:templateId/activate", asyncHandler(async (req, res) => {
  const template = await requireTemplate(req);
  await EmailTemplate.updateMany(
    { property_id: template.property_id, category: template.category, _id: { $ne: template._id } },
    { $set: { active: false } }
  );
  template.active = true;
  template.updated_by = actorFromRequest(req);
  await template.save();
  return res.status(200).json({ message: `${template.name} is now used for ${template.category} emails.`, template: serializeTemplate(template) });
}));

router.delete("/:templateId", asyncHandler(async (req, res) => {
  const template = await requireTemplate(req);
  await template.deleteOne();
  return res.status(200).json({ message: "Email template deleted." });
}));

router.use((error, _req, res, next) => {
  if (error?.code === 11000) {
    return res.status(409).json({ message: "A template with this name already exists in the selected category." });
  }
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
    return res.status(400).json({
      message: "Email template validation failed.",
      errors: Object.values(error.errors || {}).map((item) => item.message)
    });
  }
  return next(error);
});

function templatePayload(body) {
  const category = String(body?.category || "").trim().toLowerCase();
  if (!EMAIL_CATEGORIES.includes(category)) throw httpError(400, "A valid email category is required.");
  return {
    category,
    name: String(body?.name || "").trim(),
    subject: String(body?.subject || "").trim(),
    blocks: Array.isArray(body?.blocks) ? body.blocks.map((block) => ({
      block_id: String(block?.id || new mongoose.Types.ObjectId()),
      kind: String(block?.kind || ""),
      title: String(block?.title || ""),
      content: String(block?.content || "")
    })) : []
  };
}

async function requireTemplate(req) {
  if (!mongoose.isValidObjectId(req.params.templateId)) throw httpError(400, "templateId is invalid.");
  const template = await EmailTemplate.findOne({
    _id: req.params.templateId,
    property_id: requirePropertyId(req)
  });
  if (!template) throw httpError(404, "Email template not found.");
  return template;
}

function requirePropertyId(req) {
  const propertyId = String(req.query.property_id || req.body?.property_id || req.get("x-property-id") || "").trim();
  if (!propertyId) throw httpError(400, "property_id is required.");
  return propertyId;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = router;
