const express = require("express");
const Invoice = require("../db_models/invoice.model");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const status = normalizeStatus(req.query.status);
  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 20), 100);
  const baseMatch = {
    property_id: propertyId,
    status: { $in: ["issued", "partially_paid", "paid"] }
  };

  applyDateRange(baseMatch, "invoice_date", req.query.date_from, req.query.date_to);
  const search = String(req.query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), "i");
    baseMatch.$or = [
      { invoice_no: pattern },
      { reservation_no: pattern },
      { reference_number: pattern },
      { "billing_snapshot.name": pattern },
      { "billing_snapshot.email": pattern }
    ];
  }

  const statusMatch = status === "all" ? {} : { receivable_status: status };
  const [result] = await Invoice.aggregate([
    { $match: baseMatch },
    {
      $addFields: {
        balance_due: {
          $max: [
            { $subtract: ["$grand_total", { $add: ["$credited_amount", "$paid_amount"] }] },
            0
          ]
        }
      }
    },
    {
      $addFields: {
        receivable_status: {
          $cond: [{ $gt: ["$balance_due", 0] }, "to_be_paid", "paid"]
        }
      }
    },
    { $match: statusMatch },
    { $sort: { invoice_date: -1, _id: -1 } },
    {
      $facet: {
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        metadata: [{ $count: "total" }]
      }
    }
  ]);

  const rows = result?.rows || [];
  const total = result?.metadata?.[0]?.total || 0;
  return res.status(200).json({
    count: rows.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    receivables: rows.map(serializeReceivable)
  });
}));

function serializeReceivable(invoice) {
  const dueDate = invoice.due_date ? new Date(invoice.due_date) : new Date(invoice.invoice_date);
  const age = invoice.receivable_status === "paid"
    ? 0
    : Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / 86400000));
  return {
    _id: String(invoice._id),
    invoice_id: String(invoice._id),
    invoice_no: invoice.invoice_no,
    reservation_no: invoice.reservation_no,
    name: invoice.billing_snapshot?.name || "Guest",
    email: invoice.billing_snapshot?.email || "",
    invoice_date: invoice.invoice_date,
    due_date: invoice.due_date,
    invoice_value: money(invoice.grand_total),
    credited_amount: money(invoice.credited_amount),
    paid_amount: money(invoice.paid_amount),
    balance_due: money(invoice.balance_due),
    currency: invoice.currency,
    age,
    status: invoice.receivable_status
  };
}

function applyDateRange(query, field, from, to) {
  if (!from && !to) return;
  const range = {};
  if (from) range.$gte = parseDate(from, "date_from");
  if (to) range.$lte = endOfDay(to, "date_to");
  if (range.$gte && range.$lte && range.$gte > range.$lte) {
    throw httpError(400, "date_from cannot be after date_to.");
  }
  query[field] = range;
}

function normalizeStatus(value) {
  const status = String(value || "all").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!["all", "to_be_paid", "paid"].includes(status)) {
    throw httpError(400, "status must be all, to_be_paid, or paid.");
  }
  return status;
}

function requirePropertyId(req) {
  const id = String(req.query.property_id || req.get("x-property-id") || "").trim();
  if (!id) throw httpError(400, "property_id is required.");
  return id;
}

function parseDate(value, field) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) throw httpError(400, `${field} must be a valid date.`);
  return date;
}

function endOfDay(value, field) {
  const date = parseDate(value, field);
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

router.use((error, _req, res, _next) => {
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: "Receivables could not be loaded." });
});

module.exports = router;
