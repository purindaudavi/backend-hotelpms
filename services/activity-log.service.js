const AuditLog = require("../db_models/booking-log.model");

const ENTITY_TYPES = Object.freeze([...AuditLog.schema.path("entity_type").enumValues]);
const EXPORT_LIMIT = 5000;
const fail = message => Object.assign(new Error(message), { statusCode: 400 });

function timezoneFor(property) {
  const value = property?.info?.timezone || "Asia/Colombo";
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return value; }
  catch { return "Asia/Colombo"; }
}

function dateBoundary(value, timeZone, nextDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail("Use YYYY-MM-DD for dates.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw fail("Enter a valid calendar date.");
  const target = date.getTime() + (nextDay ? 86400000 : 0);
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = target - (represented - guess);
  }
  return new Date(guess);
}

function textParam(value, name, max = 200) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > max) throw fail(`${name} must be text with at most ${max} characters.`);
  return value.trim();
}

function activityFilter(propertyId, params, timeZone) {
  const filter = { property_id: propertyId };
  const search = textParam(params.search, "Search"), user = textParam(params.user, "User");
  const entity = textParam(params.entity_type, "Module", 60), action = textParam(params.action, "Action", 120);
  if (entity && !ENTITY_TYPES.includes(entity)) throw fail("Select a valid activity module.");
  if (action && !/^[a-z0-9_]+$/i.test(action)) throw fail("Select a valid activity action.");
  if (entity) filter.entity_type = entity;
  if (action) filter.action = action;
  const literal = value => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (search) filter.$or = ["description", "action", "actor.name", "actor.email"].map(field => ({ [field]: literal(search) }));
  if (user) filter.$and = [{ $or: ["actor.name", "actor.email", "actor.user_id"].map(field => ({ [field]: literal(user) })) }];
  const from = textParam(params.date_from, "From date", 10), to = textParam(params.date_to, "To date", 10);
  if (from || to) {
    filter.created_at = {};
    if (from) filter.created_at.$gte = dateBoundary(from, timeZone);
    if (to) filter.created_at.$lt = dateBoundary(to, timeZone, true);
    if (from && to && from > to) throw fail("From date must be on or before To date.");
  }
  return filter;
}

function pageNumber(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || Number(value) > max) throw fail(`Pagination must be between 1 and ${max}.`);
  return Number(value);
}

// Changes are snapshots, not a dump of related documents or uploaded files.
const sensitive = /password|secret|token|authorization|api[_-]?key|(^|[._-])(data|buffer|content)([._-]|$)/i;
function safeValue(value, depth = 0) {
  if (value === undefined || value === null) return null;
  if (depth > 4) return "[Further details omitted]";
  if (typeof value === "string") return value.length > 1000 ? value.slice(0, 1000) + "…" : value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value?._bsontype === "Binary") return "[File content omitted]";
  if (value?._bsontype === "ObjectId") return String(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeValue(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, sensitive.test(key) ? "[Hidden]" : safeValue(item, depth + 1)]));
  return value;
}

function serializeLog(log) {
  return { id: String(log._id), created_at: log.created_at, entity_type: log.entity_type, entity_id: String(log.entity_id), action: log.action,
    description: log.description, actor: { user_id: log.actor?.user_id || "", name: log.actor?.name || "System", email: log.actor?.email || "" },
    changes: (log.changes || []).slice(0, 100).map(change => ({ field: change.field, from: sensitive.test(change.field) ? "[Hidden]" : safeValue(change.from), to: sensitive.test(change.field) ? "[Hidden]" : safeValue(change.to) })) };
}

function csvCell(value) {
  let cell = String(value ?? "");
  // Quoting alone does not prevent spreadsheet formula execution.
  if (/^[\s\uFEFF]*[=+@-]/.test(cell)) cell = "'" + cell;
  return `"${cell.replaceAll('"', '""')}"`;
}

function exportCsv(logs, timeZone) {
  const date = value => new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value));
  const rows = [["Date (UTC)", "Hotel local time", "Timezone", "User", "Email", "Module", "Action", "Activity", "Record ID"],
    ...logs.map(log => [new Date(log.created_at).toISOString(), date(log.created_at), timeZone, log.actor.name, log.actor.email, log.entity_type, log.action, log.description, log.entity_id])];
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}

module.exports = { ENTITY_TYPES, EXPORT_LIMIT, activityFilter, timezoneFor, pageNumber, serializeLog, exportCsv, dateBoundary };
