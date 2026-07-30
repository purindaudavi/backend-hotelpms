const BookingAuditLog = require("../db_models/booking-log.model");

function actorFromRequest(req) {
  return {
    user_id: String(req.get("x-user-id") || "").trim(),
    name: String(req.get("x-user-name") || "System").trim() || "System",
    email: String(req.get("x-user-email") || "").trim().toLowerCase()
  };
}

async function writeAuditLog({
  propertyId,
  entityType,
  entityId,
  action,
  description,
  actor,
  changes = [],
  requestId = "",
  session
}) {
  const payload = {
    property_id: propertyId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    description,
    actor,
    changes,
    request_id: requestId
  };

  const [log] = await BookingAuditLog.create([payload], { session });
  return log;
}

function changesFromPayload(before, after, fields) {
  const changes = [];
  for (const field of fields) {
    const from = valueAtPath(before, field);
    const to = valueAtPath(after, field);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ field, from, to });
  }
  return changes;
}

function valueAtPath(source, path) {
  return path.split(".").reduce((value, key) => value?.[key], source);
}

module.exports = {
  actorFromRequest,
  changesFromPayload,
  writeAuditLog
};
