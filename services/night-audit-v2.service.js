const crypto = require("node:crypto");
const Reservation = require("../db_models/booking.model");
const Invoice = require("../db_models/invoice.model");
const Payment = require("../db_models/reservation-payment.model");
const Transaction = require("../db_models/financial-transaction.model");
const RoomType = require("../db_models/rooms.model");
const { dateBoundary, timezoneFor } = require("./activity-log.service");
const { dateKey, dateOnly, addDays } = require("./night-audit.service");
const money = n => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const todayAt = (timezone, now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const issue = (id, group, title, detail, canOverride = true, severity = "blocker", link = "") => ({ id, group, title, detail, can_override: canOverride, severity, link });

function portion(amount, count, index) {
  const cents = Math.round(Number(amount || 0) * 100), base = Math.floor(cents / count);
  return (base + (index < cents - base * count ? 1 : 0)) / 100;
}

function creditedComponents(invoice) {
  const parts = (invoice.line_items || []).flatMap(line => ["net_amount", "tax_amount"].map(field => ({ key: `${line._id}:${field}`, cents: Math.round(Number(line[field] || 0) * 100) })));
  const total = parts.reduce((sum, p) => sum + p.cents, 0), credit = Math.min(total, Math.round(Number(invoice.credited_amount || 0) * 100));
  let remaining = credit;
  for (const p of parts) { const share = total ? credit * p.cents / total : 0; p.credit = Math.floor(share); p.remainder = share - p.credit; remaining -= p.credit; }
  for (const p of [...parts].sort((a, b) => b.remainder - a.remainder)) { if (remaining <= 0) break; if (p.credit < p.cents) { p.credit++; remaining--; } }
  return new Map(parts.map(p => [p.key, (p.cents - p.credit) / 100]));
}

// Allocate the invoice's existing accommodation/meal lines, never bill them again.
// Remainder cents are deterministic so allocations sum back to the issued line.
function dailyCharges(reservation, invoices, day) {
  const lines = [];
  for (const invoice of invoices) {
    if (!["issued", "partially_paid", "paid", "credited"].includes(invoice.status)) continue;
    const stay = invoice.stay_snapshot;
    if (!stay?.check_in || !stay?.check_out) continue;
    const start = dateOnly(stay.check_in), count = stay.is_day_room ? 1 : Math.max(1, Math.round((dateOnly(stay.check_out) - start) / 86400000));
    const index = Math.round((dateOnly(day) - start) / 86400000);
    if (index < 0 || index >= count) continue;
    // Credits without a line/date attribution are apportioned across the invoice.
    const adjusted = creditedComponents(invoice);
    for (const line of invoice.line_items || []) {
      if (!["accommodation", "meal"].includes(line.source_type)) continue;
      if (line.exact_service_date && dateKey(line.service_date) !== dateKey(day)) continue;
      const lineDays = line.exact_service_date ? 1 : count;
      const lineDay = line.exact_service_date ? 0 : index;
      const net = portion(line.net_amount, lineDays, lineDay), tax = portion(line.tax_amount, lineDays, lineDay);
      const adjustedNet = portion(adjusted.get(`${line._id}:net_amount`), lineDays, lineDay);
      const adjustedTax = portion(adjusted.get(`${line._id}:tax_amount`), lineDays, lineDay);
      lines.push({ reservation_id: String(reservation._id), reservation_no: reservation.reservation_no, guest: reservation.booker?.name || "",
        invoice_id: String(invoice._id), invoice_no: invoice.invoice_no, line_id: String(line._id), room: line.room_number || "", category: line.source_type,
        currency: invoice.currency, net, tax, credit: money(net + tax - adjustedNet - adjustedTax), total: money(adjustedNet + adjustedTax),
        day_use: Boolean(stay.is_day_room), basis: invoice.stay_override
          ? `Owner-approved additional stay invoice (original ${invoice.stay_override.invoice_no})`
          : "Existing invoice allocation; not an additional charge or payment" });
    }
  }
  return lines;
}

function sumCurrencies(rows, amount = "amount") {
  const result = new Map();
  for (const row of rows) result.set(row.currency, money((result.get(row.currency) || 0) + row[amount]));
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }));
}

function receiptSummary(payments) {
  const groups = new Map();
  for (const p of payments) {
    const method = p.payment_method || "other", key = `${p.currency}:${method}`;
    const group = groups.get(key) || { key, currency: p.currency, method, expected: 0, count: 0 };
    group.expected = money(group.expected + p.amount); group.count++; groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

async function snapshot(property, audit, session) {
  const day = dateKey(audit.business_date), timezone = timezoneFor(property);
  const range = { $gte: dateBoundary(day, timezone), $lt: dateBoundary(day, timezone, true) };
  const property_id = property.property_id;
  const [reservations, invoices, payments, transactions, types] = await Promise.all([
    Reservation.find({ property_id, deleted_at: { $exists: false }, status: { $in: ["tentative", "confirmed", "checked_in", "checked_out"] } }).session(session).lean(),
    Invoice.find({ property_id, status: { $in: ["issued", "partially_paid", "paid", "credited"] } }).session(session).lean(),
    Payment.find({ property_id, status: { $in: ["posted", "refunded"] }, posted_at: range }).sort({ _id: 1 }).session(session).lean(),
    Transaction.find({ property_id, status: "posted", transaction_date: range, source_type: { $in: ["refund", "expense", "supplier_payment", "withdrawal", "money_request", "money_request_return"] } }).sort({ _id: 1 }).session(session).lean(),
    RoomType.find({ property_id, active: true }).session(session).lean()
  ]);
  const issues = [], charges = [], rooms = types.flatMap(t => t.physical_rooms.filter(r => r.active !== false).map(r => ({ id: String(r._id), room: r.room_number, type: t.name, operational_status: r.operational_status, housekeeping_status: r.housekeeping_status })));
  const byReservation = new Map();
  invoices.forEach(i => { const key = String(i.reservation_id); byReservation.set(key, [...(byReservation.get(key) || []), i]); });
  for (const r of reservations) {
    const start = dateKey(r.check_in), end = dateKey(r.check_out), link = `reservation/bookings/${r.reservation_no}`;
    if (["tentative", "confirmed"].includes(r.status) && start <= day) issues.push(issue(`arrival:${r._id}`, "front-desk-status", `${r.reservation_no}: arrival unresolved`, `${r.booker?.name || "Guest"} was expected ${start}. Check in, update the dates or mark no-show after checking.`, true, "blocker", link));
    if (r.status === "checked_in" && end <= day) issues.push(issue(`departure:${r._id}`, "front-desk-status", `${r.reservation_no}: departure unresolved`, "Complete checkout or extend the stay after confirming with the guest.", true, "blocker", link));
    const stayed = ["checked_in", "checked_out"].includes(r.status) && start <= day && (r.is_day_room ? start === day : end > day);
    if (stayed) {
      const allocation = dailyCharges(r, byReservation.get(String(r._id)) || [], day);
      if (!allocation.some(c => c.category === "accommodation")) issues.push(issue(`invoice:${r._id}`, "folio-posting", `${r.reservation_no}: accommodation invoice needed`, "Issue the guest accommodation invoice before running, including a zero-value invoice for complimentary stays. The audit will not invent a charge from the full bill.", false, "blocker", "financials/invoices"));
      charges.push(...allocation);
    }
  }
  for (const room of rooms) {
    if (["dirty", "in_progress"].includes(room.housekeeping_status)) issues.push(issue(`housekeeping:${room.id}`, "housekeeping-close", `Room ${room.room}: ${room.housekeeping_status.replaceAll("_", " ")}`, "Complete housekeeping, or ask Owner/Admin to document why it can remain unfinished.", true, "blocker", "housekeeping/board"));
    if (["out_of_order", "maintenance"].includes(room.operational_status)) issues.push(issue(`room:${room.id}`, "housekeeping-close", `Room ${room.room}: ${room.operational_status.replaceAll("_", " ")}`, "Room remains excluded from normal operations.", false, "warning", "housekeeping/board"));
  }
  const receipts = payments.map(p => ({ id: String(p._id), invoice_no: p.invoice_no || "", reservation_id: String(p.reservation_id), currency: p.currency, amount: p.amount, payment_method: p.payment_method, reference: p.payment_reference || "", at: p.posted_at, actor: p.posted_by }));
  const payment_fingerprint = fingerprint(receipts);
  const reconciliationCurrent = audit.reconciliation?.fingerprint === payment_fingerprint;
  const groups = receiptSummary(payments).map(g => ({ ...g, verification: reconciliationCurrent ? audit.reconciliation.entries?.find(e => e.key === g.key) : undefined }));
  for (const group of groups) {
    if (!group.verification) issues.push(issue(`payment:${group.key}`, "payment-reconciliation", `${group.currency} ${group.method}: verify receipts`, `Compare ${group.count} receipt(s), expected ${group.expected.toFixed(2)}, with actual cash receipts / terminal report / bank evidence.`, false));
    else if (money(group.verification.actual - group.expected) !== 0) issues.push(issue(`payment-difference:${group.key}`, "payment-reconciliation", `${group.currency} ${group.method}: receipt difference`, `Expected ${group.expected.toFixed(2)}; verified ${group.verification.actual.toFixed(2)}. ${group.verification.note || ""}`, true));
  }
  for (const p of receipts) if (p.payment_method !== "cash" && !p.reference) issues.push(issue(`reference:${p.id}`, "payment-reconciliation", `${p.invoice_no || "Payment"}: missing payment reference`, "Confirm against the terminal / bank evidence; no card details are required.", false, "warning", "financials/invoices"));
  const overrides = new Map(audit.overrides.map(o => [o.exception_id, o]));
  const exceptions = issues.map(i => { const context_hash = fingerprint([i.title, i.detail, i.group === "payment-reconciliation" ? payment_fingerprint : ""]), saved = overrides.get(i.id);
    const overridden = Boolean(i.can_override && saved?.context_hash === context_hash);
    return { ...i, context_hash, overridden, override: overridden ? saved : undefined }; });
  const balances = invoices.map(i => ({ invoice_no: i.invoice_no, reservation_no: i.reservation_no, guest: i.billing_snapshot?.name || "", currency: i.currency,
    amount: money(Math.max(Number(i.grand_total || 0) - Number(i.credited_amount || 0) - Number(i.paid_amount || 0), 0)) })).filter(i => i.amount > 0);
  const outflows = transactions.filter(t => t.direction === "out").map(t => ({ reference: t.transaction_no, source: t.source_type, currency: t.currency, amount: t.amount }));
  const returns = transactions.filter(t => t.source_type === "money_request_return").map(t => ({ reference: t.transaction_no, currency: t.currency, amount: t.amount }));
  return { business_date: day, timezone, currency: audit.currency, receipt_groups: groups, receipts, payment_fingerprint, reconciliation_current: reconciliationCurrent,
    receipt_totals: sumCurrencies(payments), outflows, outflow_totals: sumCurrencies(outflows), returned_advances: returns, returned_totals: sumCurrencies(returns),
    charges, charge_totals: sumCurrencies(charges, "total"), balances, balance_totals: sumCurrencies(balances), rooms,
    reservations: reservations.map(r => ({ reservation_no: r.reservation_no, guest: r.booker?.name || "", check_in: dateKey(r.check_in), check_out: dateKey(r.check_out), status: r.status, day_use: Boolean(r.is_day_room) })),
    exceptions, blockers: exceptions.filter(i => i.severity === "blocker" && !i.overridden), warnings: exceptions.filter(i => i.severity === "warning"),
    legacy_posting: Boolean(audit.revenue_transaction_id), channel_connected: false };
}

const reportDefinitions = [
  ["business-analysis", "Daily overview", s => [{ business_date: s.business_date, rooms: s.rooms.length, receipts: s.receipt_totals, billed_stay_allocations: s.charge_totals, outflows: s.outflow_totals }]],
  ["collection-report", "Payments received", s => s.receipts],
  ["revenue-report", "Billed stay charges by service day", s => s.charges],
  ["inventory-by-room-type", "Room and housekeeping status", s => s.rooms],
  ["reservation-list", "Reservation status", s => s.reservations],
  ["customer-balance-summary", "Outstanding guest invoices", s => s.balances]
];

module.exports = { snapshot, dailyCharges, portion, sumCurrencies, receiptSummary, fingerprint, money, todayAt, error, reportDefinitions, dateKey, dateOnly, addDays, timezoneFor };
