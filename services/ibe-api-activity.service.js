const IbeApiActivity = require("../db_models/ibe-api-activity.model");
const IbeSettings = require("../db_models/ibe-settings.model");
const WebsiteKey = require("../db_models/ibe-website-key.model");

async function recordIbeActivity(req, operation, statusCode, details = {}) {
  const propertyId = req.params.propertyId;
  if (!/^[a-z\d][a-z\d_-]{0,99}$/i.test(propertyId || "") || propertyId === "demo") return;
  try {
    const exists = await IbeSettings.exists({ _id: propertyId });
    if (!exists) return;
    await IbeApiActivity.create({
      property_id: propertyId, operation,
      origin: req.ibeIntegration?.website_origin || "",
      integration_id: req.ibeIntegration?.id || "", integration_name: req.ibeIntegration?.name || "",
      status_code: statusCode, ...details
    });
  } catch (error) {
    // The reservation's transactional audit remains authoritative if telemetry fails.
    console.error("IBE request activity could not be recorded", error.name);
  }
}

async function listIbeActivity(propertyId) {
  const settings = await IbeSettings.findById(propertyId, { "settings.websiteOrigin": 1 }).lean();
  const origin = settings?.settings?.websiteOrigin || "";
  const credential = await WebsiteKey.findById(propertyId).lean();
  const latest = credential && !credential.revoked_at ? await IbeApiActivity.findOne({
    property_id: propertyId, integration_id: credential.key_id, status_code: { $gte: 200, $lt: 300 }
  }).sort({ created_at: -1, _id: -1 }).lean() : null;
  const activities = await IbeApiActivity.find({ property_id: propertyId })
    .sort({ created_at: -1, _id: -1 }).limit(50).lean();
  return {
    website_origin: origin,
    last_success_at: latest?.created_at || null,
    last_success_origin: latest?.origin || "",
    recent_activity: Boolean(latest && Date.now() - new Date(latest.created_at).getTime() < 15 * 60 * 1000),
    retention_days: 30,
    activities: activities.map(({ _id, property_id, ...entry }) => ({ id: String(_id), ...entry }))
  };
}

module.exports = { recordIbeActivity, listIbeActivity };
