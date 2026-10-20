const jwt = require("jsonwebtoken");
const User = require("../db_models/user.model");
const Property = require("../db_models/property.model");

function isLegacyAdministrator(user) {
  return ["admin", "developer"].includes(user?.role);
}

function propertyRole(property, user) {
  if (!property || !user || property.status === "inactive") return null;
  const userId = String(user._id);
  if (String(property.owner_id || "") === userId) return "owner";
  if ((property.member_ids || []).some((id) => String(id) === userId)) return "member";
  // Preserve existing administrators' access without assigning older hotels to
  // whoever happens to sign in first. New accounts cannot self-register as admin.
  if (!property.owner_id && isLegacyAdministrator(user)) return "owner";
  return null;
}

function accessiblePropertiesQuery(user) {
  const access = [{ owner_id: user._id }, { member_ids: user._id }];
  if (isLegacyAdministrator(user)) access.push({ owner_id: null });
  return { status: "active", $or: access };
}

async function authenticateWorkspace(req, res, next) {
  const match = /^Bearer (\S+)$/i.exec(req.get("authorization") || "");
  if (!match) return res.status(401).json({ message: "Sign in to access your hotels." });
  let payload;
  try {
    payload = jwt.verify(match[1], process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return res.status(401).json({ message: "Your session has expired. Please sign in again." });
  }
  try {
    const user = await User.findById(payload.id).select("-password");
    if (!user) return res.status(401).json({ message: "Account not found." });
    req.workspaceUser = user;
    req.user = { id: String(user._id) };
    // Audit records and notifications must use the verified identity.
    req.headers["x-user-id"] = String(user._id);
    req.headers["x-user-name"] = user.name;
    req.headers["x-user-email"] = user.email;
    next();
  } catch (error) { next(error); }
}

function resolveRequestPropertyId(req) {
  const pathId = /^\/properties\/([^/]+)/.exec(req.path)?.[1];
  const values = [pathId && decodeURIComponent(pathId), req.query.property_id,
    req.body?.property_id, req.get("x-property-id")].filter((value) => value !== undefined && value !== "");
  if (values.some((value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,99}$/.test(value))) {
    throw Object.assign(new Error("A valid property ID is required."), { statusCode: 400 });
  }
  if (new Set(values).size > 1) {
    throw Object.assign(new Error("The request contains conflicting property IDs."), { statusCode: 400 });
  }
  return values[0];
}

async function requirePropertyAccess(req, res, next) {
  try {
    // Listing and creation are authenticated, but do not require an existing hotel.
    if (/^\/properties\/?$/.test(req.path) && ["GET", "POST"].includes(req.method)) return next();
    if (req.path === "/reports/catalog") return next();
    const propertyId = resolveRequestPropertyId(req);
    if (!propertyId) return res.status(400).json({ message: "Select a property for this request." });
    const property = await Property.findOne({ property_id: propertyId });
    const role = propertyRole(property, req.workspaceUser);
    if (!role) return res.status(403).json({ message: "You do not have access to this property.", code: "PROPERTY_ACCESS_DENIED" });
    req.authorizedProperty = property;
    req.propertyRole = role;
    req.headers["x-property-id"] = propertyId;
    next();
  } catch (error) { next(error); }
}

async function requireDemoReadAccess(req, res, next) {
  try {
    // A demo session is public, so never allow it to change MongoDB data or
    // access another property. Production must explicitly opt in.
    const enabled = process.env.DEMO_WORKSPACE_ENABLED === "true" ||
      (process.env.NODE_ENV !== "production" && process.env.DEMO_WORKSPACE_ENABLED !== "false");
    if (!enabled || req.method !== "GET") {
      return res.status(403).json({ message: "The demo workspace is read-only.", code: "DEMO_READ_ONLY" });
    }
    if (/^\/properties\/?$/.test(req.path) || /^\/properties\/demo\/(?:access|audit-log)(?:\/|$)/.test(req.path) ||
        /^\/(?:mail|email-templates|integrations)(?:\/|$)/.test(req.path) ||
        /^\/bookings\/reservations\/[^/]+\/attachments(?:\/|$)/.test(req.path)) {
      return res.status(403).json({ message: "Sign in to manage hotel access.", code: "DEMO_ACCESS_DENIED" });
    }
    if (req.path === "/reports/catalog") return next();
    const propertyId = resolveRequestPropertyId(req);
    if (propertyId !== "demo") {
      return res.status(403).json({ message: "Demo access is limited to the demo hotel.", code: "PROPERTY_ACCESS_DENIED" });
    }
    const property = await Property.findOne({ property_id: "demo" });
    if (!property || property.status === "inactive") {
      return res.status(404).json({ message: "The demo hotel is unavailable." });
    }
    req.authorizedProperty = property;
    req.propertyRole = "demo";
    req.headers["x-property-id"] = "demo";
    req.headers["x-user-id"] = "demo-readonly";
    req.headers["x-user-name"] = "Demo Viewer";
    req.headers["x-user-email"] = "";
    next();
  } catch (error) { next(error); }
}

function isPublicPropertyMedia(req) {
  // Hotel logos and room photos are public marketing assets. No records,
  // attachments, credentials or guest information are exposed by these routes.
  return req.method === "GET" && (
    /^\/properties\/[^/]+\/images\/[a-f0-9]{24}\/content\/?$/i.test(req.path) ||
    /^\/rooms\/[a-f0-9]{24}\/images\/[a-f0-9]{24}\/?$/i.test(req.path)
  );
}

module.exports = { propertyRole, accessiblePropertiesQuery, resolveRequestPropertyId,
  authenticateWorkspace, requirePropertyAccess, requireDemoReadAccess, isPublicPropertyMedia };
