const assert = require("node:assert/strict");
const test = require("node:test");
const Reservation = require("../db_models/booking.model");
const BusinessBlock = require("../db_models/business-block.model");
const RoomType = require("../db_models/rooms.model");
const Invoice = require("../db_models/invoice.model");
const CreditNote = require("../db_models/credit-note.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const Refund = require("../db_models/refund.model");
const Expense = require("../db_models/expense.model");
const Purchase = require("../db_models/purchase.model");
const { REPORT_CATALOG, generateReport, normalizeReportParameters, reportToCsv } = require("../services/report-generation.service");

const propertyId = "report-test-hotel";
const date = (day) => new Date(`2026-11-${String(day).padStart(2, "0")}T00:00:00Z`);
const parameters = { date_from: "2026-11-20", date_to: "2026-11-25", as_of: "2026-11-25" };

function run(type, filters = {}) {
  return generateReport({ propertyId, reportType: type, parameters: normalizeReportParameters({ ...parameters, ...filters }) });
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((part) => matches(row, part));
    const value = key.split(".").reduce((part, segment) => part?.[segment], row);
    if (typeof condition !== "object" || condition === null) return value === condition;
    return Object.entries(condition).every(([op, other]) => {
      switch (op) {
        case "$in": return other.includes(value);
        case "$nin": return !other.includes(value);
        case "$exists": return (value !== undefined) === other;
        case "$ne": return value !== other;
        case "$gte": return value >= other;
        case "$lt": return value < other;
        case "$gt": return value > other;
        default: assert.fail(`Unexpected fixture filter ${op}`);
      }
    });
  });
}

function fixture(t, model, rows) {
  t.mock.method(model, "find", (filter) => {
    assert.equal(filter.property_id, propertyId);
    return {
      sort() { return this; },
      async lean() { return rows.filter((row) => matches(row, filter)); }
    };
  });
}

const invoice = {
  property_id: propertyId, status: "partially_paid", invoice_no: "INV-TEST-001",
  reservation_id: "stay-one", reservation_no: "RES-TEST-001", currency: "LKR",
  invoice_date: date(20), due_date: date(23), billing_snapshot: { name: "Sample Guest" },
  subtotal: 10000, tax_total: 1000, grand_total: 11000, credited_amount: 5500, paid_amount: 2000
};

test("invoice daybook, customer balances and aging use issued invoice data", async (t) => {
  fixture(t, Invoice, [
    invoice,
    { ...invoice, invoice_no: "INV-USD", currency: "USD", status: "paid", paid_amount: 5500 },
    { ...invoice, invoice_no: "DRAFT", status: "draft" },
    { ...invoice, invoice_no: "VOIDED", status: "voided" },
    { ...invoice, invoice_no: "FUTURE", invoice_date: date(28) },
    { ...invoice, invoice_no: "OTHER", property_id: "other" }
  ]);

  const daybook = await run("invoice-daybook");
  assert.deepEqual(daybook.rows.map((row) => row.invoice_no), ["INV-TEST-001", "INV-USD"]);
  assert.equal(daybook.rows[0].tax, 1000);
  assert.match(reportToCsv(daybook), /INV-TEST-001/);

  const balances = await run("customer-balance-summary");
  assert.deepEqual(balances.rows.map((row) => [row.invoice_no, row.balance]), [["INV-TEST-001", 3500]]);
  assert.deepEqual(balances.totals.amount_by_currency, { LKR: 3500 });

  const aging = await run("ar-aging-summary", { date_from: "2026-11-24" });
  assert.equal(aging.rows.length, 1);
  assert.equal(aging.rows[0].days_outstanding, 2);
  assert.equal(aging.rows[0].aging_bucket, "1-30");
});

test("in-house stays show multiple invoices without inflating guest or room counts", async (t) => {
  const stay = { _id: "stay-one", property_id: propertyId, status: "checked_in", reservation_no: "RES-TEST-001",
    check_in: date(22), check_out: date(28), currency: "LKR", booker: { name: "Sample Guest" }, rooms: [{}] };
  fixture(t, Reservation, [stay]);
  fixture(t, Invoice, [invoice, { ...invoice, invoice_no: "INV-EXTENSION", grand_total: 5000, credited_amount: 0, paid_amount: 0 }]);
  const report = await run("in-house-guest-ledger");
  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.summary, { in_house_reservations: 1, in_house_rooms: 1 });
  assert.equal(report.totals.balance_by_currency.LKR, 8500);
});

test("collection and deposit ledger include completed refunds on completion date, by currency", async (t) => {
  const payment = { _id: "payment", property_id: propertyId, status: "posted", reservation_id: "stay-one",
    currency: "LKR", posted_at: date(20), amount: 5000, payment_method: "cash" };
  const refund = { _id: "refund", refund_no: "REF-001", property_id: propertyId, status: "completed",
    reservation_id: "stay-one", currency: "LKR", completed_at: date(25), amount: 1000 };
  fixture(t, Reservation, [{ _id: "stay-one", property_id: propertyId, reservation_no: "RES-TEST-001" }]);
  fixture(t, ReservationPayment, [payment, { ...payment, _id: "usd", currency: "USD", amount: 50 },
    { ...payment, _id: "void", status: "voided" }]);
  fixture(t, Refund, [refund, { ...refund, _id: "pending", status: "pending" }, { ...refund, _id: "later", completed_at: date(26) }]);
  const collection = await run("collection-report");
  assert.equal(collection.rows.length, 3);
  assert.deepEqual(collection.totals, {
    received_by_currency: { LKR: 5000, USD: 50 },
    refunded_by_currency: { LKR: 1000 },
    amount_by_currency: { LKR: 4000, USD: 50 }
  });
  assert.deepEqual(collection.rows.at(-1).amount, -1000);
  const deposit = await run("deposit-ledger");
  assert.equal(deposit.summary.reservation_count, 1);
  assert.equal(deposit.rows.length, 2);
  assert.deepEqual(deposit.totals.amount_by_currency, collection.totals.amount_by_currency);
});

test("revenue and operational profit exclude tax, deduct credits and count each recorded cost once", async (t) => {
  fixture(t, Invoice, [invoice, { ...invoice, invoice_no: "USD-001", currency: "USD", grand_total: 100, tax_total: 10 }]);
  fixture(t, CreditNote, [
    { property_id: propertyId, status: "issued", credit_note_no: "CN-001", currency: "LKR", credit_date: date(23), total_credit: 5500, tax_total: 500 },
    { property_id: propertyId, status: "voided", credit_note_no: "CN-VOID", currency: "LKR", credit_date: date(23), total_credit: 5000 }
  ]);
  fixture(t, Purchase, [
    { property_id: propertyId, status: "paid", currency: "LKR", purchase_date: date(23), amount: 1000 },
    { property_id: propertyId, status: "to_be_paid", currency: "LKR", purchase_date: date(24), amount: 500 }
  ]);
  fixture(t, Expense, [
    { property_id: propertyId, status: "posted", currency: "LKR", expense_date: date(25), amount: 800, cash_request_id: "staff" },
    { property_id: propertyId, status: "voided", currency: "LKR", expense_date: date(25), amount: 500 }
  ]);
  const revenue = await run("revenue-report");
  assert.equal(revenue.totals.net_revenue_by_currency.LKR, 5000);
  assert.equal(revenue.totals.tax_by_currency.LKR, 500);
  const profit = await run("profit-loss");
  assert.deepEqual(profit.rows[0], {
    currency: "LKR", invoice_revenue: 10000, credit_notes: 5000, net_revenue: 5000,
    purchases: 1500, expenses: 800, total_costs: 2300, profit: 2700
  });
  assert.deepEqual(profit.totals.profit_by_currency, { LKR: 2700, USD: 90 });
});

test("room revenue forecast uses the room subtotal and includes same-day stays on the cutoff date", async (t) => {
  const stay = {
    property_id: propertyId, status: "confirmed", currency: "LKR",
    is_day_room: true, check_in: date(25), check_out: date(25),
    financial_summary: { room_total: 6000, grand_total: 7800 }
  };
  fixture(t, Reservation, [stay, { ...stay, status: "cancelled" }]);
  const report = await run("revenue-forecast");
  assert.equal(report.rows.length, 1);
  assert.deepEqual(report.totals.room_revenue_by_currency, { LKR: 6000 });
});

test("travel agent totals keep separate currencies for the same agent", async (t) => {
  const stay = {
    property_id: propertyId, status: "confirmed", check_in: date(25), check_out: date(26), rooms: [{}],
    travel_agent: { name: "Sample Agent", commission_amount: 100 },
    financial_summary: { grand_total: 6000 }, currency: "LKR"
  };
  fixture(t, Reservation, [{
    ...stay
  }, {
    ...stay, currency: "USD", financial_summary: { grand_total: 50 },
    travel_agent: { ...stay.travel_agent, commission_amount: 4 }
  }]);
  const report = await run("travel-agent-performance");
  assert.equal(report.summary.travel_agent_count, 1);
  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.totals.revenue_by_currency, { LKR: 6000, USD: 50 });
  assert.deepEqual(report.totals.commission_by_currency, { LKR: 100, USD: 4 });
});

test("occupancy excludes offline stock and accounts for day use and remaining block holds", async (t) => {
  fixture(t, RoomType, [{ _id: "standard", property_id: propertyId, active: true,
    physical_rooms: [{ active: true }, { active: true }, { active: true, operational_status: "maintenance" }] }]);
  fixture(t, Reservation, [{
    property_id: propertyId, status: "confirmed", currency: "USD", is_day_room: true,
    check_in: date(24), check_out: date(24),
    rooms: [{ room_type_id: "standard", business_block_allocation_id: "allocation" }]
  }]);
  fixture(t, BusinessBlock, [{
    property_id: propertyId, status: "active", check_in: date(24), check_out: date(26),
    allocations: [{ _id: "allocation", room_type_id: "standard", quantity: 2, released_quantity: 0 }]
  }]);
  const result = await run("occupancy-by-date", { date_from: "2026-11-24", currency: "LKR" });
  assert.deepEqual(result.rows, [
    { date: "2026-11-24", total_rooms: 2, occupied_rooms: 1, blocked_rooms: 0, business_block_holds: 1, available_rooms: 0, occupancy_percentage: 50 },
    { date: "2026-11-25", total_rooms: 2, occupied_rooms: 0, blocked_rooms: 0, business_block_holds: 2, available_rooms: 0, occupancy_percentage: 0 }
  ]);
});

test("Trial Balance remains unavailable without the accounting ledger", async () => {
  assert.deepEqual(REPORT_CATALOG.filter((item) => !item.available).map((item) => item.report_type), ["trial-balance"]);
  await assert.rejects(run("trial-balance"), { statusCode: 501, code: "REPORT_DATA_SOURCE_NOT_AVAILABLE" });
});
