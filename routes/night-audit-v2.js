const express = require("express"), mongoose = require("mongoose");
const NightAudit = require("../db_models/night-audit.model"), Property = require("../db_models/property.model"), Report = require("../db_models/reports.model");
const { withInventoryTransaction } = require("../services/inventory-transaction.service");
const { propertyRole } = require("../services/property-access.service");
const { permissionsForProperty, canRunNightAudit } = require("../services/property-permissions.service");
const { actorFromRequest, writeAuditLog } = require("../services/booking-audit.service");
const { voidFinancialTransaction } = require("../services/financial-transaction.service");
const V = require("../services/night-audit-v2.service");
const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const ownerAdmin = role => ["owner", "administrator"].includes(role);

async function context(req, session, mutation = false) {
  const property = await Property.findOne({ property_id: req.authorizedProperty.property_id, status: "active" }).session(session);
  const role = propertyRole(property, req.workspaceUser), permissions = permissionsForProperty(role, property, req.workspaceUser?._id);
  if (!(ownerAdmin(role) || role === "finance" || canRunNightAudit(role, permissions))) throw V.error(403, "Your Night Audit access changed. Reload your workspace.");
  if (mutation && !canRunNightAudit(role, permissions)) throw V.error(403, "Your role can review completed audits but cannot change an open audit.");
  return { property, role, session, actor: actorFromRequest(req) };
}
async function current(req, ctx, checkId = false) {
  if (!ctx.property.business_date) { ctx.property.business_date = V.dateOnly(V.todayAt(V.timezoneFor(ctx.property))); await ctx.property.save({ session: ctx.session }); }
  let audit = await NightAudit.findOne({ property_id: ctx.property.property_id, business_date: ctx.property.business_date }).session(ctx.session);
  if (!audit) [audit] = await NightAudit.create([{ property_id: ctx.property.property_id, business_date: ctx.property.business_date, currency: ctx.property.info.home_currency, workflow_version: 2, created_by: ctx.actor, updated_by: ctx.actor }], { session: ctx.session });
  if (checkId && String(audit._id) !== req.body?.audit_id) throw V.error(409, "The audit day changed. Refresh before retrying; no later day was closed.");
  if (checkId && audit.status !== "open") throw V.error(409, "This day is already closed.");
  return audit;
}
async function view(audit, ctx) {
  return { ...audit.toObject(), _id: String(audit._id), business_date: V.dateKey(audit.business_date), next_business_date: audit.next_business_date ? V.dateKey(audit.next_business_date) : "",
    snapshot: audit.status === "closed" ? audit.close_summary : await V.snapshot(ctx.property, audit, ctx.session), legacy: audit.status === "closed" && audit.workflow_version !== 2,
    permissions: { run: canRunNightAudit(ctx.role, permissionsForProperty(ctx.role, ctx.property, ctx.actor.user_id)), override: ownerAdmin(ctx.role), verify: ownerAdmin(ctx.role) || ctx.role === "finance" } };
}
const atomic = (mutation, handler) => asyncRoute(async (req, res) => {
  const response = await withInventoryTransaction(req.authorizedProperty.property_id, async session => handler(req, await context(req, session, mutation)));
  res.set("Cache-Control", "private, no-store").json(response);
});
const log = (ctx, audit, action, description) => writeAuditLog({ propertyId: ctx.property.property_id, entityType: "night_audit", entityId: audit._id, action, description, actor: ctx.actor, session: ctx.session });
router.get("/current", atomic(false, async (req, ctx) => ({ night_audit: await view(await current(req, ctx), ctx) })));
router.get("/history", asyncRoute(async (req, res) => {
  const ctx = await context(req, null), records = await NightAudit.find({ property_id: ctx.property.property_id, status: "closed" }).sort({ business_date: -1 }).limit(100)
    .select("business_date status workflow_version closed_at closed_by finance_review_status finance_reviewed_by finance_reviewed_at version next_business_date").lean();
  res.json({ night_audits: records.map(a => ({ ...a, _id: String(a._id), business_date: V.dateKey(a.business_date), next_business_date: a.next_business_date ? V.dateKey(a.next_business_date) : "" })) });
}));
router.post("/current/reconciliation", atomic(true, async (req, ctx) => {
  const audit = await current(req, ctx, true), s = await V.snapshot(ctx.property, audit, ctx.session);
  if (req.body.fingerprint !== s.payment_fingerprint) throw V.error(409, "Payments changed. Refresh and compare the updated receipts before saving.");
  if (!Array.isArray(req.body.entries) || req.body.entries.length !== s.receipt_groups.length) throw V.error(400, "Verify every payment method and currency shown.");
  const entries = [], seen = new Set();
  for (const input of req.body.entries) {
    const group = s.receipt_groups.find(g => g.key === input.key), actual = input.actual, note = typeof input.note === "string" ? input.note.trim() : "";
    if (!group || seen.has(input.key) || typeof actual !== "number" || !Number.isFinite(actual) || actual < 0 || Math.abs(actual * 100 - Math.round(actual * 100)) > 0.00001 || note.length > 1000 || input.confirmed !== true) throw V.error(400, "Enter valid amounts, confirm the external check and keep notes within 1,000 characters.");
    if (V.money(actual - group.expected) !== 0 && note.length < 5) throw V.error(400, "Explain the difference before saving (at least 5 characters).");
    seen.add(input.key); entries.push({ key: group.key, actual: V.money(actual), expected: group.expected, note, confirmed: true });
  }
  audit.reconciliation = { fingerprint: s.payment_fingerprint, entries, verified_by: ctx.actor, verified_at: new Date() };
  audit.updated_by = ctx.actor; await audit.save({ session: ctx.session });
  await log(ctx, audit, "night_audit_receipts_verified", "Receipts compared manually with external cash/card/bank evidence. No bank connection is implied.");
  return { night_audit: await view(audit, ctx) };
}));
router.post("/current/override", atomic(true, async (req, ctx) => {
  if (!ownerAdmin(ctx.role)) throw V.error(403, "Only Owner/Admin can override a blocker.");
  const audit = await current(req, ctx, true), s = await V.snapshot(ctx.property, audit, ctx.session), reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 1000) throw V.error(400, "Explain the exception using 10–1,000 characters.");
  const issue = s.blockers.find(i => i.id === req.body.exception_id);
  if (!issue?.can_override || issue.context_hash !== req.body.context_hash) throw V.error(409, "This issue changed, was resolved, or requires a fix. Refresh.");
  audit.overrides.push({ step_id: issue.group, exception_id: issue.id, context_hash: issue.context_hash, reason, approved_by: ctx.actor, approved_at: new Date() });
  audit.updated_by = ctx.actor; await audit.save({ session: ctx.session });
  await log(ctx, audit, "night_audit_override_approved", `${issue.title}: ${reason}`); return { night_audit: await view(audit, ctx) };
}));
router.post("/current/run", atomic(true, async (req, ctx) => {
  const audit = await current(req, ctx, true);
  if (req.body.confirmed !== true) throw V.error(400, "Confirm the displayed business date before running.");
  if (V.dateKey(audit.business_date) > V.todayAt(V.timezoneFor(ctx.property))) throw V.error(409, "A future business day cannot be closed.");
  const closeNote = typeof req.body.close_note === "string" ? req.body.close_note.trim() : "";
  if (closeNote.length > 3000) throw V.error(400, "Keep the handover note within 3,000 characters.");
  const s = await V.snapshot(ctx.property, audit, ctx.session);
  if (s.blockers.length) return { outcome: "blocked", night_audit: await view(audit, ctx) };
  await voidFinancialTransaction({ propertyId: ctx.property.property_id, sourceType: "night_audit", sourceId: audit._id,
    reason: "Replaced legacy aggregate with existing invoice allocations; Night Audit did not receive cash.", actor: ctx.actor, session: ctx.session });
  audit.workflow_version = 2; audit.reports = [];
  for (const [report_type, title, rowsFor] of V.reportDefinitions) {
    const rows = rowsFor(s), generated_at = new Date();
    const [report] = await Report.create([{ property_id: ctx.property.property_id, night_audit_id: audit._id, report_type, title,
      parameters: { date_from: audit.business_date, date_to: audit.business_date, as_of: audit.business_date }, status: "generated", rows, row_count: rows.length,
      summary: { business_date: s.business_date, timezone: s.timezone }, limitations: ["Daily allocations reuse existing invoiced charges. Credits are apportioned proportionally; no extra revenue or cash is posted.", "Receipt verification is manual; bank/card data is not automatically imported."], generated_at, generated_by: ctx.actor }], { session: ctx.session });
    audit.reports.push({ report_type, title, report_run_id: report._id, generated_at });
  }
  audit.revenue_posted_at = new Date(); audit.revenue_posted_amount = s.charge_totals.find(c => c.currency === audit.currency)?.amount || 0; audit.revenue_transaction_id = undefined;
  audit.reviewed_step_ids = ["front-desk-status", "folio-posting", "payment-reconciliation", "housekeeping-close", "audit-reports"];
  audit.reports_generated_at = new Date(); audit.close_summary = s; audit.close_note = closeNote; audit.status = "closed"; audit.closed_at = new Date(); audit.closed_by = ctx.actor; audit.updated_by = ctx.actor;
  audit.next_business_date = V.addDays(audit.business_date, 1); ctx.property.business_date = audit.next_business_date; ctx.property.updated_by = ctx.actor;
  await audit.save({ session: ctx.session }); await ctx.property.save({ session: ctx.session });
  await log(ctx, audit, "night_audit_completed", `${s.business_date} closed; six frozen reports saved; next day ${V.dateKey(audit.next_business_date)}. No duplicate guest charge or cash entry created.`);
  return { outcome: "closed", night_audit: await view(audit, ctx) };
}));
router.post("/:auditId/finance-review", atomic(false, async (req, ctx) => {
  if (!(ownerAdmin(ctx.role) || ctx.role === "finance")) throw V.error(403, "Only Finance or Owner/Admin can verify completed audits.");
  const audit = await findAudit(req.params.auditId, ctx);
  if (audit.status !== "closed") throw V.error(409, "Complete the audit before verifying it.");
  if (!Number.isInteger(req.body.version) || req.body.version !== audit.version) throw V.error(409, "Another review was saved. Reload this audit before reviewing again.");
  const note = typeof req.body.note === "string" ? req.body.note.trim() : "", status = req.body.status;
  if (!["reviewed", "flagged"].includes(status) || req.body.confirmed !== true || note.length > 3000) throw V.error(400, "Confirm your review and keep the note to 3,000 characters or fewer.");
  const followUp = ["reviewed", "flagged"].includes(audit.finance_review_status);
  if (note.length < 5 && (followUp || status === "flagged")) {
    throw V.error(400, followUp ? "Enter a follow-up reason of at least 5 characters." : "Explain the flagged difference in at least 5 characters.");
  }
  const at = new Date(); audit.finance_review_status = status; audit.finance_review_note = note; audit.finance_reviewed_by = ctx.actor; audit.finance_reviewed_at = at;
  audit.finance_review_history.push({ status, note, actor: ctx.actor, at }); await audit.save({ session: ctx.session });
  const description = note ? `${status} by ${ctx.actor.name}: ${note}` : `${status} by ${ctx.actor.name}`;
  await log(ctx, audit, "night_audit_finance_review", description.slice(0, 2000));
  return { night_audit: await view(audit, ctx) };
}));
router.get("/:auditId/reports/:reportId", asyncRoute(async (req, res) => {
  const ctx = await context(req, null), audit = await findAudit(req.params.auditId, ctx);
  if (!mongoose.isValidObjectId(req.params.reportId) || !audit.reports.some(r => String(r.report_run_id) === req.params.reportId)) throw V.error(404, "Audit report not found.");
  const report = await Report.findOne({ _id: req.params.reportId, property_id: ctx.property.property_id }).lean();
  if (!report) throw V.error(404, "Audit report not found."); res.json({ report });
}));
router.get("/:auditId", asyncRoute(async (req, res) => { const ctx = await context(req, null); res.json({ night_audit: await view(await findAudit(req.params.auditId, ctx), ctx) }); }));
async function findAudit(id, ctx) {
  if (!mongoose.isValidObjectId(id)) throw V.error(400, "Invalid audit ID.");
  const audit = await NightAudit.findOne({ _id: id, property_id: ctx.property.property_id }).session(ctx.session);
  if (!audit) throw V.error(404, "Audit not found."); return audit;
}
router.use((error, _req, res, _next) => {
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) return res.status(400).json({ message: error.message });
  const status = error.statusCode || 500; if (status >= 500) console.error(error);
  res.status(status).json({ message: status >= 500 ? "The audit could not finish. Refresh to confirm the day status before retrying." : error.message });
});
module.exports = router;
