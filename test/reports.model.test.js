const assert = require("node:assert/strict");
const test = require("node:test");
const ReportRun = require("../db_models/reports.model");
const {
  REPORT_CATALOG,
  normalizeReportParameters,
  reportToCsv
} = require("../services/report-generation.service");

function validRun(overrides = {}) {
  return new ReportRun({
    property_id: " demo ",
    report_type: "reservation-list",
    title: " List   of Reservations ",
    parameters: {
      date_from: "2026-08-01",
      date_to: "2026-08-31",
      as_of: "2026-08-04"
    },
    row_count: 2,
    limitations: [" One limitation ", "One limitation"],
    ...overrides
  });
}

test("validates and normalizes report generation history", async () => {
  const run = validRun();
  await run.validate();
  assert.equal(run.property_id, "demo");
  assert.equal(run.title, "List of Reservations");
  assert.deepEqual(run.limitations, ["One limitation"]);
});

test("rejects an invalid report type and date range", async () => {
  await assert.rejects(validRun({ report_type: "unknown-report" }).validate());
  await assert.rejects(validRun({ parameters: {
    date_from: "2026-08-31", date_to: "2026-08-01", as_of: "2026-08-04"
  } }).validate(), /cannot be before/);
});

test("normalizes report parameters and rejects excessive ranges", () => {
  const parameters = normalizeReportParameters({
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    as_of: "2026-08-04",
    currency: "lkr"
  });
  assert.equal(parameters.currency, "LKR");
  assert.equal(parameters.date_from.toISOString().slice(0, 10), "2026-08-01");
  assert.throws(() => normalizeReportParameters({
    date_from: "2025-01-01", date_to: "2026-08-31"
  }), /cannot exceed 366 days/);
});

test("catalog distinguishes available reports and CSV escapes values", () => {
  assert.equal(REPORT_CATALOG.find((item) => item.report_type === "reservation-list").available, true);
  assert.equal(REPORT_CATALOG.find((item) => item.report_type === "trial-balance").available, false);
  const csv = reportToCsv({
    columns: [{ key: "guest", label: "Guest" }],
    rows: [{ guest: 'Perera, "Nimal"' }]
  });
  assert.match(csv, /"Perera, ""Nimal"""/);
});
