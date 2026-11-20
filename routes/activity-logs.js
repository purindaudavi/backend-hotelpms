const express = require("express");
const AuditLog = require("../db_models/booking-log.model");
const NightAudit = require("../db_models/night-audit.model");
const { propertyRole } = require("../services/property-access.service");
const { ENTITY_TYPES, EXPORT_LIMIT, activityFilter, timezoneFor, pageNumber, serializeLog, exportCsv } = require("../services/activity-log.service");
const { dateKey } = require("../services/night-audit.service");

const router = express.Router();
router.use((req, res, next) => {
  // Include an explicit guard here: public demo requests bypass department rules.
  const role = propertyRole(req.authorizedProperty, req.workspaceUser);
  if (!["owner", "administrator"].includes(role)) return res.status(403).json({ message: "Only the property Owner or Administrator can view activity logs.", code: "PROPERTY_PERMISSION_DENIED" });
  res.set("Cache-Control", "private, no-store");
  next();
});

const run = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const projection = "created_at entity_type entity_id action description actor changes";
const order = { created_at: -1, _id: -1 };

router.get("/export", run(async (req, res) => {
  const property = req.authorizedProperty, timezone = timezoneFor(property);
  const filter = activityFilter(property.property_id, req.query, timezone);
  const logs = await AuditLog.find(filter).select("created_at entity_type entity_id action description actor").sort(order).limit(EXPORT_LIMIT + 1).lean();
  if (logs.length > EXPORT_LIMIT) return res.status(422).json({ message: `More than ${EXPORT_LIMIT.toLocaleString("en-US")} activities match. Narrow the dates or filters before exporting.` });
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="activity-logs.csv"', "X-Content-Type-Options": "nosniff" });
  res.send(exportCsv(logs.map(serializeLog), timezone));
}));

router.get("/", run(async (req, res) => {
  const property = req.authorizedProperty, timezone = timezoneFor(property);
  const filter = activityFilter(property.property_id, req.query, timezone);
  const page = pageNumber(req.query.page, 1, 10000), limit = pageNumber(req.query.limit, 50, 100);
  const [logs, total] = await Promise.all([
    AuditLog.find(filter).select(projection).sort(order).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);
  const isAuditReview = log => log.entity_type === "night_audit" && log.action === "night_audit_finance_review";
  const auditIds = [...new Set(logs.filter(isAuditReview).map(log => String(log.entity_id)))];
  const audits = auditIds.length
    ? await NightAudit.find({ property_id: property.property_id, _id: { $in: auditIds } }).select("business_date").lean()
    : [];
  const datesByAuditId = new Map(audits.map(audit => [String(audit._id), dateKey(audit.business_date)]));
  const entries = logs.map(log => {
    const entry = serializeLog(log);
    const businessDate = isAuditReview(log) && datesByAuditId.get(entry.entity_id);
    return businessDate ? { ...entry, audit_business_date: businessDate } : entry;
  });
  res.json({ logs: entries, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), timezone, entity_types: ENTITY_TYPES });
}));

module.exports = router;
