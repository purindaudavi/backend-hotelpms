const Invoice = require("../db_models/invoice.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const CreditNote = require("../db_models/credit-note.model");
const Refund = require("../db_models/refund.model");

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const id = (value) => String(value || "");
const currency = (value) => String(value || "").trim().toUpperCase();

// Read only. Checkout repeats this calculation inside the inventory transaction;
// the browser's earlier preview is never accepted as evidence of settlement.
async function getCheckoutReview(reservation, session = null) {
  const query = { property_id: reservation.property_id, reservation_id: reservation._id };
  const invoices = await Invoice.find(query).sort({ invoice_date: 1, _id: 1 }).session(session).lean();
  const linkedQuery = { property_id: reservation.property_id, $or: [
    { reservation_id: reservation._id }, { invoice_id: { $in: invoices.map((invoice) => invoice._id) } }
  ] };
  // Sequential queries also work in a MongoDB transaction (no parallel commands).
  const payments = await ReservationPayment.find(linkedQuery).session(session).lean();
  const credits = await CreditNote.find(linkedQuery).session(session).lean();
  const refunds = await Refund.find(linkedQuery).session(session).lean();
  return buildCheckoutReview(reservation, { invoices, payments, credits, refunds });
}

function buildCheckoutReview(reservation, { invoices = [], payments = [], credits = [], refunds = [] } = {}) {
  const issues = [];
  const active = invoices.filter((invoice) => invoice.status !== "voided");
  const relevant = payments.filter((payment) => payment.status === "posted" || payment.status === "refunded");
  function totals(records, expectedCurrency, amountKey, sign = () => 1) {
    if (records.some((record) => currency(record.currency) !== expectedCurrency || !Number.isFinite(Number(record[amountKey])))) {
      issues.push("Some billing records have inconsistent amounts or currencies. Ask an owner/administrator to reconcile them.");
    }
    return money(records.filter((record) => currency(record.currency) === expectedCurrency)
      .reduce((sum, record) => sum + Number(record[amountKey] || 0) * sign(record), 0));
  }
  const rows = active.map((invoice) => {
    const code = currency(invoice.currency);
    const paid = totals(relevant.filter((record) => id(record.invoice_id) === id(invoice._id)), code, "amount",
      (record) => record.status === "refunded" ? -1 : 1);
    const refunded = totals(refunds.filter((record) => id(record.invoice_id) === id(invoice._id) && record.status === "completed"), code, "amount");
    const credited = totals(credits.filter((record) => id(record.invoice_id) === id(invoice._id) && record.status === "issued"), code, "total_credit");
    const total = money(invoice.grand_total || 0);
    const netPaid = money(Math.max(paid - refunded, 0));
    const adjusted = money(Math.max(total - credited, 0));
    if (!Number.isFinite(total) || total < 0 || credited > total) issues.push(`Invoice ${invoice.invoice_no} needs financial review.`);
    if (invoice.status === "draft" && total > 0) issues.push(`Invoice ${invoice.invoice_no} is still a draft. Ask an owner/administrator to issue or correct it.`);
    return {
      id: id(invoice._id), reference: invoice.invoice_no, status: invoice.status, currency: code,
      total, paid: netPaid, credited, balance_due: money(Math.max(adjusted - netPaid, 0)),
      refund_due: money(Math.max(netPaid - adjusted, 0)),
      lines: (invoice.line_items || []).map((line) => ({
        description: line.description, category: line.source_type, quantity: line.quantity,
        amount: money(Math.max(Number(line.quantity || 0) * Number(line.unit_price || 0) - Number(line.discount_amount || 0), 0) * (1 + Number(line.tax_rate || 0) / 100))
      }))
    };
  });

  const reservationCurrency = currency(reservation.currency);
  const reservationTotal = money(reservation.financial_summary?.grand_total || 0);
  if (!Number.isFinite(reservationTotal) || reservationTotal < 0) issues.push("The reservation total needs financial review.");
  if (!active.length) {
    // Legacy stays without invoices use actual payment records, not a client-paid summary.
    const paid = totals(relevant, reservationCurrency, "amount", (record) => record.status === "refunded" ? -1 : 1);
    const refunded = totals(refunds.filter((record) => record.status === "completed"), reservationCurrency, "amount");
    if (invoices.length && reservationTotal > 0) issues.push("All linked invoices are voided. Ask an owner/administrator to reconcile the stay billing.");
    rows.push({ id: "reservation", reference: reservation.reservation_no, status: "reservation_balance", currency: reservationCurrency,
      total: reservationTotal, paid: money(Math.max(paid - refunded, 0)), credited: 0,
      balance_due: money(Math.max(reservationTotal - Math.max(paid - refunded, 0), 0)), refund_due: money(Math.max(paid - refunded - reservationTotal, 0)), lines: [] });
  } else {
    // Never count accommodation twice, or silently consume an unallocated deposit.
    if (relevant.some((record) => !record.invoice_id)) issues.push("There are unallocated reservation payments. Ask an owner/administrator to reconcile them with the guest invoices.");
    const billed = money(rows.filter((row) => row.currency === reservationCurrency).reduce((sum, row) => sum + row.total, 0));
    if (billed < reservationTotal) issues.push(`The saved reservation total exceeds linked invoice totals by ${reservationCurrency} ${money(reservationTotal - billed).toFixed(2)}. Ask an owner/administrator to reconcile the charges.`);
  }
  const totalsByCurrency = [];
  for (const row of rows) {
    let group = totalsByCurrency.find((item) => item.currency === row.currency);
    if (!group) { group = { currency: row.currency, total: 0, paid: 0, credited: 0, balance_due: 0, refund_due: 0 }; totalsByCurrency.push(group); }
    for (const field of ["total", "paid", "credited", "balance_due", "refund_due"]) group[field] = money(group[field] + row[field]);
  }
  if (totalsByCurrency.some((group) => group.balance_due > 0)) issues.push("Outstanding guest charges must be settled before checkout. Record payment against the relevant invoice, then refresh this review.");
  if (reservation.status !== "checked_in") issues.push("Only a checked-in reservation can be checked out.");
  return { reservation_id: id(reservation._id), reservation_no: reservation.reservation_no, guest_name: reservation.booker?.name || "",
    invoices: rows, totals_by_currency: totalsByCurrency, issues: [...new Set(issues)], can_check_out: !issues.length,
    checked_at: new Date().toISOString() };
}

function assertCheckoutSettled(review) {
  if (review.can_check_out) return;
  const due = review.totals_by_currency.filter((group) => group.balance_due > 0)
    .map((group) => `${group.currency} ${group.balance_due.toFixed(2)}`).join(", ");
  throw Object.assign(new Error(due
    ? `Checkout blocked: ${due} is outstanding. Review guest invoices, record the payment and try again.`
    : `Checkout blocked: ${review.issues[0]}`), { statusCode: 409, code: "CHECKOUT_NOT_SETTLED" });
}

module.exports = { getCheckoutReview, buildCheckoutReview, assertCheckoutSettled };
