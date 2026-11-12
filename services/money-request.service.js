const mongoose = require("mongoose");
const Property = require("../db_models/property.model");
const Expense = require("../db_models/expense.model");
const { propertyRole } = require("./property-access.service");
const { nextDocumentNumber } = require("./financial-document.service");
const REQUEST_ROLES = ["owner", "administrator", "finance", "front_desk", "housekeeping"];
function fail(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
async function context(req, session = null) {
  const id = String(req.get("x-property-id") || req.body?.property_id || req.query.property_id || "");
  const property = await Property.findOne({ property_id: id, status: "active" }).session(session);
  const role = propertyRole(property, req.workspaceUser);
  if (!property || !REQUEST_ROLES.includes(role)) throw fail(403, "Your property role cannot use money requests.");
  return { property, propertyId: id, role, userId: String(req.workspaceUser._id) };
}
function visibleFilter(ctx) {
  return { property_id: ctx.propertyId, ...(["owner", "administrator"].includes(ctx.role) ? {} : { requester_id: ctx.userId }) };
}
function requireOwner(ctx) { if (ctx.role !== "owner") throw fail(403, "Only this property's Owner can approve, reject, pay or settle money requests."); }
function checkVersion(record, version) {
  if (!Number.isInteger(version) || version !== (record.__v || 0)) throw fail(409, "This request changed. Refresh it before trying again.");
}
function positiveAmount(value) {
  const result = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(result) || result <= 0) throw fail(400, "Enter an amount greater than zero.");
  return result;
}
function paidDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 300000) throw fail(400, "Enter the actual payment date and time, not a future date.");
  return date;
}
function event(record, action, actor, note = "") { record.history.push({ action, actor, note, at: new Date() }); }
async function recordRequestCost(record, amount, actor, session) {
  if (amount <= 0) return;
  const expenseDate = record.kind === "advance" ? new Date() : record.paid_at;
  const no = await nextDocumentNumber({ propertyId: record.property_id, documentType: "expense", date: expenseDate, session });
  const [expense] = await Expense.create([{
    property_id: record.property_id, expense_no: no, expense_date: expenseDate,
    expense_type: "Staff work payment", paid_using: record.payment_method,
    amount, currency: record.currency, description: `${record.request_no}: ${record.purpose}`,
    remark: "Money already recorded out by the linked money request. Do not record another payment.",
    cash_request_id: record._id, status: "posted", created_by: actor
  }], { session });
  // Deliberately no second cash transaction: the request paid it already.
  record.expense_id = expense._id;
}
function serialize(record) {
  const raw = record.toObject ? record.toObject() : record;
  return { ...raw, version: record.__v || 0, receipts: (raw.receipts || []).map(({ data, ...receipt }) => receipt) };
}
function receiptInput(body) {
  const type = body?.content_type, name = String(body?.name || "receipt").split(/[\\/]/).pop().slice(0, 150);
  if (!["image/jpeg", "image/png", "application/pdf"].includes(type) || typeof body.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw fail(400, "Upload a JPG, PNG or PDF receipt.");
  const data = Buffer.from(body.data, "base64");
  const valid = type === "image/jpeg" ? data.subarray(0, 3).equals(Buffer.from([255,216,255])) : type === "image/png" ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : data.subarray(0, 5).toString() === "%PDF-";
  if (!valid || !data.length || data.length > 3 * 1024 * 1024) throw fail(400, "Upload a valid JPG, PNG or PDF no larger than 3 MB.");
  return { name, content_type: type, data, size: data.length };
}
module.exports = { context, visibleFilter, requireOwner, checkVersion, positiveAmount, paidDate, event, recordRequestCost, serialize, receiptInput, fail, REQUEST_ROLES };
