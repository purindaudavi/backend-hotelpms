const express = require("express");
const mongoose = require("mongoose");
const NightAudit = require("../db_models/night-audit.model");
const { NIGHT_AUDIT_STEP_IDS } = require("../db_models/night-audit.model");
const Property = require("../db_models/property.model");
const ReportRun = require("../db_models/reports.model");
const { actorFromRequest, writeAuditLog } = require("../services/booking-audit.service");
const { postFinancialTransaction } = require("../services/financial-transaction.service");
const {
  addDays,
  buildNightAuditSnapshot,
  buildNightAuditSteps,
  dateKey,
  dateOnly,
  httpError,
  nightAuditCanComplete,
  serializeNightAudit,
  unresolvedBlockers
} = require("../services/night-audit.service");
const { generateReport, normalizeReportParameters } = require("../services/report-generation.service");

const router = express.Router();
const NIGHT_AUDIT_REPORTS = [
  "business-analysis",
  "deposit-ledger",
  "occupancy-by-date",
  "revenue-report",
  "inventory-by-room-type",
  "reservation-list"
];

router.get("/current", asyncHandler(async (req, res) => {
  const context = await currentAuditContext(req);
  return res.status(200).json(await responseView(context));
}));

router.get("/history", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const records = await NightAudit.find({ property_id: propertyId, status: "closed" })
    .sort({ business_date: -1 })
    .limit(limit);
  return res.status(200).json({ count: records.length, night_audits: records.map(serializeHistoryRecord) });
}));

router.post("/current/review", asyncHandler(async (req, res) => {
  const stepId = requireStepId(req.body?.step_id);
  const context = await currentAuditContext(req);
  requireOpen(context.audit);
  const snapshot = await buildNightAuditSnapshot(context);
  const selected = buildNightAuditSteps(context.audit, snapshot).find((item) => item.id === stepId);
  if (selected.disabled) throw conflict(`${selected.title} is disabled for this property.`);
  if (selected.status === "blocked") {
    const error = conflict(`${selected.title} has unresolved blockers.`);
    error.details = selected.exceptions.filter((item) => item.severity === "blocker" && !item.resolved);
    throw error;
  }
  addReviewedStep(context.audit, stepId);
  context.audit.updated_by = actorFromRequest(req);
  await context.audit.save();
  await logAuditAction(req, context.audit, "night_audit_step_reviewed", `${selected.title} was reviewed.`);
  return res.status(200).json(await responseView(context));
}));

router.post("/current/override", asyncHandler(async (req, res) => {
  const stepId = requireStepId(req.body?.step_id);
  const reason = String(req.body?.reason || "").replace(/\s+/g, " ").trim();
  if (reason.length < 10) throw badRequest("An override reason of at least 10 characters is required.");
  const context = await currentAuditContext(req);
  requireOpen(context.audit);
  const snapshot = await buildNightAuditSnapshot(context);
  const selected = buildNightAuditSteps(context.audit, snapshot).find((item) => item.id === stepId);
  const requestedIds = Array.isArray(req.body?.exception_ids)
    ? new Set(req.body.exception_ids.map((value) => String(value)))
    : null;
  const blockers = selected.exceptions.filter((item) =>
    item.severity === "blocker" && !item.resolved && (!requestedIds || requestedIds.has(item.id))
  );
  if (!blockers.length) throw badRequest("No unresolved blocker matched this override request.");
  const actor = actorFromRequest(req);
  blockers.forEach((blocker) => context.audit.overrides.push({
    step_id: stepId,
    exception_id: blocker.id,
    reason,
    approved_by: actor,
    approved_at: new Date()
  }));
  addReviewedStep(context.audit, stepId);
  context.audit.updated_by = actor;
  await context.audit.save();
  await logAuditAction(req, context.audit, "night_audit_override_approved", `${blockers.length} blocker(s) were overridden for ${selected.title}: ${reason}`);
  return res.status(200).json(await responseView(context));
}));

router.post("/current/post-room-revenue", asyncHandler(async (req, res) => {
  const result = await inTransaction(async (session) => {
    const context = await currentAuditContext(req, session);
    requireOpen(context.audit);
    const snapshot = await buildNightAuditSnapshot({ ...context, session });
    const actor = actorFromRequest(req);
    if (!context.audit.revenue_posted_at && snapshot.estimated_room_revenue > 0) {
      const transaction = await postFinancialTransaction({
        propertyId: context.audit.property_id,
        sourceType: "night_audit",
        sourceId: context.audit._id,
        sourceNumber: `NA-${dateKey(context.audit.business_date).replaceAll("-", "")}`,
        transactionDate: context.audit.business_date,
        direction: "in",
        accountingEffect: "increase",
        amount: snapshot.estimated_room_revenue,
        currency: context.audit.currency,
        description: `Night Audit room revenue for ${dateKey(context.audit.business_date)}.`,
        actor,
        requestId: requestId(req),
        session
      });
      context.audit.revenue_posted_at = new Date();
      context.audit.revenue_posted_amount = snapshot.estimated_room_revenue;
      context.audit.revenue_transaction_id = transaction._id;
    }
    addReviewedStep(context.audit, "folio-posting");
    context.audit.updated_by = actor;
    await context.audit.save({ session });
    await writeAuditLog({
      propertyId: context.audit.property_id,
      entityType: "night_audit",
      entityId: context.audit._id,
      action: "night_audit_room_revenue_posted",
      description: `${context.audit.currency} ${context.audit.revenue_posted_amount.toFixed(2)} room revenue was posted for ${dateKey(context.audit.business_date)}.`,
      actor,
      requestId: requestId(req),
      session
    });
    return context;
  });
  return res.status(200).json(await responseView(result));
}));

router.post("/current/review-housekeeping", asyncHandler(async (req, res) => {
  const context = await currentAuditContext(req);
  requireOpen(context.audit);
  const snapshot = await buildNightAuditSnapshot(context);
  if (snapshot.dirty_rooms.length) {
    const error = conflict("Housekeeping has dirty or in-progress rooms. Complete them before review.");
    error.details = snapshot.dirty_rooms;
    throw error;
  }
  addReviewedStep(context.audit, "housekeeping-close");
  context.audit.updated_by = actorFromRequest(req);
  await context.audit.save();
  await logAuditAction(req, context.audit, "night_audit_housekeeping_reviewed", "The Housekeeping board was reviewed for close.");
  return res.status(200).json(await responseView(context));
}));

router.post("/current/review-channels", asyncHandler(async (req, res) => {
  const context = await currentAuditContext(req);
  requireOpen(context.audit);
  const snapshot = await buildNightAuditSnapshot(context);
  if (snapshot.channel_manager.connected) {
    throw httpError(501, "Live Channel Manager reconciliation is not available yet.", "CHANNEL_MANAGER_NOT_CONNECTED");
  }
  addReviewedStep(context.audit, "channel-check");
  context.audit.updated_by = actorFromRequest(req);
  await context.audit.save();
  return res.status(200).json(await responseView(context));
}));

router.post("/current/generate-reports", asyncHandler(async (req, res) => {
  const context = await currentAuditContext(req);
  requireOpen(context.audit);
  if (!context.audit.reports_generated_at) {
    const parameters = normalizeReportParameters({
      date_from: dateKey(context.audit.business_date),
      date_to: dateKey(context.audit.business_date),
      as_of: dateKey(context.audit.business_date),
      currency: context.audit.currency
    });
    const generated = [];
    for (const reportType of NIGHT_AUDIT_REPORTS) {
      generated.push(await generateReport({ propertyId: context.audit.property_id, reportType, parameters }));
    }
    const actor = actorFromRequest(req);
    await inTransaction(async (session) => {
      const references = [];
      for (const report of generated) {
        const [run] = await ReportRun.create([{
          property_id: context.audit.property_id,
          report_type: report.report_type,
          title: report.title,
          parameters,
          status: "generated",
          row_count: report.rows.length,
          summary: report.summary,
          totals: report.totals,
          limitations: report.limitations,
          generated_at: report.generated_at,
          generated_by: actor
        }], { session });
        references.push({ report_type: report.report_type, title: report.title, report_run_id: run._id, generated_at: report.generated_at });
      }
      const audit = await NightAudit.findById(context.audit._id).session(session);
      requireOpen(audit);
      audit.reports = references;
      audit.reports_generated_at = new Date();
      addReviewedStep(audit, "audit-reports");
      audit.updated_by = actor;
      await audit.save({ session });
      await writeAuditLog({
        propertyId: audit.property_id,
        entityType: "night_audit",
        entityId: audit._id,
        action: "night_audit_reports_generated",
        description: `${references.length} Night Audit close reports were generated.`,
        actor,
        requestId: requestId(req),
        session
      });
    });
    context.audit = await NightAudit.findById(context.audit._id);
  }
  return res.status(200).json(await responseView(context));
}));

router.patch("/current/notes", asyncHandler(async (req, res) => {
  const context = await currentAuditContext(req);
  requireOpen(context.audit);
  context.audit.close_note = String(req.body?.close_note || "").trim();
  context.audit.updated_by = actorFromRequest(req);
  await context.audit.save();
  return res.status(200).json(await responseView(context));
}));

router.post("/current/complete", asyncHandler(async (req, res) => {
  const result = await inTransaction(async (session) => {
    const context = await currentAuditContext(req, session);
    requireOpen(context.audit);
    const snapshot = await buildNightAuditSnapshot({ ...context, session });
    const steps = buildNightAuditSteps(context.audit, snapshot);
    if (!nightAuditCanComplete(steps)) {
      const error = conflict("Night Audit cannot be completed until all required checks are done.");
      error.details = {
        blockers: unresolvedBlockers(steps),
        incomplete_steps: steps.filter((item) => item.required && !["done", "reviewed_with_warnings"].includes(item.status))
          .map((item) => ({ id: item.id, title: item.title, status: item.status }))
      };
      throw error;
    }
    const actor = actorFromRequest(req);
    const nextBusinessDate = addDays(context.audit.business_date, 1);
    context.audit.status = "closed";
    context.audit.close_note = String(req.body?.close_note ?? context.audit.close_note ?? "").trim();
    context.audit.close_summary = snapshot;
    context.audit.closed_at = new Date();
    context.audit.closed_by = actor;
    context.audit.next_business_date = nextBusinessDate;
    context.audit.updated_by = actor;
    context.property.business_date = nextBusinessDate;
    context.property.updated_by = actor;
    await context.audit.save({ session });
    await context.property.save({ session });
    await writeAuditLog({
      propertyId: context.audit.property_id,
      entityType: "night_audit",
      entityId: context.audit._id,
      action: "night_audit_completed",
      description: `Business date ${dateKey(context.audit.business_date)} was closed and ${dateKey(nextBusinessDate)} was opened.`,
      actor,
      requestId: requestId(req),
      session
    });
    return context.audit;
  });
  return res.status(200).json({
    message: `Night Audit ${dateKey(result.business_date)} completed successfully.`,
    night_audit: serializeHistoryRecord(result),
    next_business_date: dateKey(result.next_business_date)
  });
}));

router.get("/:auditId", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  if (!mongoose.isValidObjectId(req.params.auditId)) throw badRequest("auditId must be a valid MongoDB ObjectId.");
  const audit = await NightAudit.findOne({ _id: req.params.auditId, property_id: propertyId });
  if (!audit) throw notFound("Night audit not found.");
  const property = await requireProperty(propertyId);
  return res.status(200).json(await responseView({ property, audit }));
}));

async function currentAuditContext(req, session = null) {
  const propertyId = requirePropertyId(req);
  const property = await requireProperty(propertyId, session);
  if (!property.business_date) {
    property.business_date = dateOnly(req.query.initial_business_date || req.body?.initial_business_date || new Date(), "initial_business_date");
    property.updated_by = actorFromRequest(req);
    await property.save({ session });
  }
  let audit = await NightAudit.findOne({ property_id: propertyId, business_date: property.business_date }).session(session);
  if (!audit) {
    const created = await NightAudit.create([{
      property_id: propertyId,
      business_date: property.business_date,
      currency: property.info?.home_currency || "LKR",
      created_by: actorFromRequest(req),
      updated_by: actorFromRequest(req)
    }], { session });
    audit = created[0];
  }
  return { property, audit };
}

async function responseView(context) {
  const snapshot = context.audit.status === "closed" && context.audit.close_summary
    ? context.audit.close_summary
    : await buildNightAuditSnapshot(context);
  const steps = buildNightAuditSteps(context.audit, snapshot);
  return { night_audit: serializeNightAudit(context.audit, snapshot, steps) };
}

async function requireProperty(propertyId, session = null) {
  const query = Property.findOne({ property_id: propertyId, status: "active" });
  if (session) query.session(session);
  const property = await query;
  if (!property) throw notFound("Active property not found.");
  return property;
}

function addReviewedStep(audit, stepId) {
  audit.reviewed_step_ids = Array.from(new Set([...(audit.reviewed_step_ids || []), stepId]));
}

function requireStepId(value) {
  const stepId = String(value || "").trim();
  if (!NIGHT_AUDIT_STEP_IDS.includes(stepId)) throw badRequest(`step_id must be one of: ${NIGHT_AUDIT_STEP_IDS.join(", ")}.`);
  return stepId;
}

function requireOpen(audit) {
  if (!audit) throw notFound("Night Audit not found.");
  if (audit.status !== "open") throw conflict("This Night Audit is already closed.");
}

async function logAuditAction(req, audit, action, description) {
  return writeAuditLog({ propertyId: audit.property_id, entityType: "night_audit", entityId: audit._id, action, description, actor: actorFromRequest(req), requestId: requestId(req) });
}

function serializeHistoryRecord(audit) {
  return {
    _id: String(audit._id), property_id: audit.property_id, business_date: dateKey(audit.business_date), status: audit.status,
    currency: audit.currency, revenue_posted_amount: audit.revenue_posted_amount, reports: audit.reports,
    close_note: audit.close_note, close_summary: audit.close_summary, closed_at: audit.closed_at, closed_by: audit.closed_by,
    next_business_date: audit.next_business_date ? dateKey(audit.next_business_date) : ""
  };
}

function requirePropertyId(req) {
  const propertyId = String(req.query.property_id || req.get("x-property-id") || req.body?.property_id || "").trim();
  if (!propertyId) throw badRequest("property_id is required.");
  return propertyId;
}
function positiveInteger(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function requestId(req) { return String(req.get("x-request-id") || "").trim(); }
function badRequest(message) { return httpError(400, message); }
function notFound(message) { return httpError(404, message, "NIGHT_AUDIT_NOT_FOUND"); }
function conflict(message) { return httpError(409, message, "NIGHT_AUDIT_CONFLICT"); }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

router.use((error, _req, res, _next) => {
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError || error.name === "BSONError") {
    return res.status(400).json({ message: "Night Audit validation failed.", errors: Object.values(error.errors || {}).map((item) => item.message) });
  }
  if (error.code === 11000) return res.status(409).json({ message: "A Night Audit already exists for this property and business date." });
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
  console.error(error);
  return res.status(500).json({ message: "The Night Audit request could not be completed." });
});

module.exports = router;
module.exports.NIGHT_AUDIT_REPORTS = NIGHT_AUDIT_REPORTS;
