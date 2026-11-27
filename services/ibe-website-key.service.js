const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const WebsiteKey = require("../db_models/ibe-website-key.model");
const Property = require("../db_models/property.model");
const IbeSettings = require("../db_models/ibe-settings.model");
const { propertyRole } = require("./property-access.service");
const { withInventoryTransaction } = require("./inventory-transaction.service");
const { writeAuditLog, actorFromRequest } = require("./booking-audit.service");

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const digest = (key) => createHash("sha256").update(key).digest("hex");

function describeKey(record) {
  return record ? {
    id: record.key_id, name: record.name, website_origin: record.website_origin,
    active: !record.revoked_at, created_at: record.created_at, revoked_at: record.revoked_at
  } : null;
}

async function getWebsiteKey(propertyId) {
  return { key: describeKey(await WebsiteKey.findById(propertyId).lean()) };
}

async function changeWebsiteKey(req, revoke = false) {
  const propertyId = req.authorizedProperty.property_id;
  const keyId = randomBytes(12).toString("hex");
  const secret = "ibe_" + keyId + "." + randomBytes(32).toString("base64url");
  const expected = req.body?.expectedKeyId;
  if (!(expected === null || typeof expected === "string" && /^[a-f0-9]{24}$/.test(expected))) {
    throw fail(400, "Refresh the website connection before changing its key.");
  }
  return withInventoryTransaction(propertyId, async (session) => {
    const property = await Property.findOne({ property_id: propertyId }).session(session);
    if (!["owner", "administrator"].includes(propertyRole(property, req.workspaceUser))) {
      throw fail(403, "Only this property's Owner or Administrator can manage website keys.");
    }
    const existing = await WebsiteKey.findById(propertyId).session(session).lean();
    if ((existing?.key_id || null) !== expected) {
      throw fail(409, "The website key changed in another session. Refresh before trying again.");
    }
    let record;
    if (revoke) {
      if (!existing || existing.revoked_at) throw fail(409, "This website key is no longer active. Refresh the connection.");
      record = await WebsiteKey.findByIdAndUpdate(propertyId, { $set: { revoked_at: new Date() } }, { returnDocument: "after", session }).lean();
    } else {
      const settings = await IbeSettings.findById(propertyId).session(session).lean();
      const origin = settings?.settings?.websiteOrigin;
      if (!origin) throw fail(400, "Save the customer website address in IBE settings before generating a key.");
      if (req.body?.websiteOrigin !== origin) throw fail(400, "Save the customer website address, then generate the key using that saved address.");
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name || name.length > 100) throw fail(400, "Enter a website connection name of up to 100 characters.");
      record = await WebsiteKey.findByIdAndUpdate(propertyId, { $set: {
        key_id: keyId, key_hash: digest(secret), name, website_origin: origin,
        created_by: req.workspaceUser._id, created_at: new Date(), revoked_at: null
      } }, { upsert: true, returnDocument: "after", runValidators: true, session }).lean();
    }
    await writeAuditLog({
      propertyId, entityType: "property", entityId: property._id,
      action: revoke ? "ibe_website_key_revoked" : existing ? "ibe_website_key_replaced" : "ibe_website_key_created",
      description: `Website connection ${record.name} (${record.website_origin}) key was ${revoke ? "revoked" : existing ? "replaced" : "created"}.`,
      actor: actorFromRequest(req), session
    });
    return { key: describeKey(record), ...(!revoke ? { secret } : {}) };
  });
}

async function authenticateWebsiteKey(req) {
  const supplied = req.get("x-ibe-api-key");
  const propertyId = req.params.propertyId;
  const invalid = () => fail(401, "A valid website API key is required for this property.");
  if (!/^[a-z\d][a-z\d_-]{0,99}$/i.test(propertyId || "") || propertyId === "demo" ||
      typeof supplied !== "string" || !/^ibe_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(supplied)) throw invalid();
  const record = await WebsiteKey.findById(propertyId).select("+key_hash").lean();
  if (!record || record.revoked_at || !/^[a-f0-9]{64}$/.test(record.key_hash || "") ||
      !timingSafeEqual(Buffer.from(digest(supplied), "hex"), Buffer.from(record.key_hash, "hex"))) throw invalid();
  req.ibeIntegration = { id: record.key_id, name: record.name, website_origin: record.website_origin };
}

module.exports = { getWebsiteKey, changeWebsiteKey, authenticateWebsiteKey };
