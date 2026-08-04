const express = require("express");
const mongoose = require("mongoose");
const ReportRun = require("../db_models/reports.model");
const {
  REPORT_CATALOG,
  generateReport,
  normalizeReportParameters,
  reportToCsv
} = require("../services/report-generation.service");
const { getDashboardSummary } = require("../services/dashboard.service");

const router = express.Router();

router.get("/catalog", (_req, res) => {
  return res.status(200).json({
    count: REPORT_CATALOG.length,
    reports: REPORT_CATALOG
  });
});

router.get("/dashboard", asyncHandler(async (req, res) => {
  const dashboard = await getDashboardSummary({
    propertyId: requirePropertyId(req),
    asOf: req.query.as_of || new Date(),
    currency: req.query.currency || ""
  });
  return res.status(200).json({ dashboard });
}));

router.get("/history", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const query = { property_id: propertyId };

  if (req.query.report_type) query.report_type = String(req.query.report_type).trim().toLowerCase();
  if (req.query.status) query.status = String(req.query.status).trim().toLowerCase();

  const [runs, total] = await Promise.all([
    ReportRun.find(query)
      .sort({ generated_at: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    ReportRun.countDocuments(query)
  ]);

  return res.status(200).json({
    count: runs.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    report_runs: runs
  });
}));

router.get("/history/:reportRunId", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.reportRunId)) {
    throw badRequest("reportRunId must be a valid MongoDB ObjectId.");
  }
  const run = await ReportRun.findOne({
    _id: req.params.reportRunId,
    property_id: requirePropertyId(req)
  });
  if (!run) throw notFound("Report generation record not found.");
  return res.status(200).json({ report_run: run });
}));

router.post("/generate", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const reportType = String(req.body?.report_type || "").trim().toLowerCase();
  if (!reportType) throw badRequest("report_type is required.");

  const format = String(req.body?.format || "json").trim().toLowerCase();
  if (!["json", "csv"].includes(format)) {
    throw badRequest("format must be json or csv.");
  }

  const parameters = normalizeReportParameters(req.body?.parameters || req.body || {});
  const report = await generateReport({ propertyId, reportType, parameters });
  const run = await ReportRun.create({
    property_id: propertyId,
    report_type: report.report_type,
    title: report.title,
    parameters,
    status: "generated",
    row_count: report.rows.length,
    summary: report.summary,
    totals: report.totals,
    limitations: report.limitations,
    generated_at: report.generated_at,
    generated_by: actorFromRequest(req)
  });

  if (format === "csv") {
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report.report_type}.csv"`,
      "X-Report-Run-Id": String(run._id)
    });
    return res.status(200).send(reportToCsv(report));
  }

  return res.status(200).json({
    message: `${report.title} generated successfully.`,
    report_run_id: run._id,
    report
  });
}));

router.use((error, _req, res, _next) => {
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError ||
    error.name === "BSONError"
  ) {
    return res.status(400).json({
      message: "Report validation failed.",
      errors: Object.values(error.errors || {}).map((item) => item.message)
    });
  }
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      message: error.message,
      code: error.code,
      required_modules: error.requiredModules
    });
  }
  console.error(error);
  return res.status(500).json({ message: "The report request could not be completed." });
});

function requirePropertyId(req) {
  const propertyId = String(
    req.query.property_id || req.get("x-property-id") || req.body?.property_id || ""
  ).trim();
  if (!propertyId) throw badRequest("property_id is required.");
  return propertyId;
}

function actorFromRequest(req) {
  return {
    user_id: String(req.get("x-user-id") || "").trim(),
    name: String(req.get("x-user-name") || "System").trim() || "System",
    email: String(req.get("x-user-email") || "").trim().toLowerCase()
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function badRequest(message) {
  return httpError(400, message);
}

function notFound(message) {
  return httpError(404, message);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = router;
