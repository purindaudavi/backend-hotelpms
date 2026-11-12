const FinancialTransaction = require("../db_models/financial-transaction.model");
const FundsOpening = require("../db_models/funds-opening.model");

// These are recorded cash movements, not invoice revenue or a bank API balance.
// Keep this whitelist independent from historical Night Audit direction flags.
const IN_SOURCES = ["payment", "money_request_return"];
const OUT_SOURCES = ["expense", "supplier_payment", "refund", "withdrawal", "money_request"];
function recordedMovement(transaction) {
  if (transaction.status !== "posted") return 0;
  if (transaction.direction === "in" && IN_SOURCES.includes(transaction.source_type)) return Number(transaction.amount);
  if (transaction.direction === "out" && OUT_SOURCES.includes(transaction.source_type)) return -Number(transaction.amount);
  return 0;
}
async function recordedFunds(propertyId, session = null) {
  const rows = await FinancialTransaction.aggregate([
    { $match: { property_id: propertyId, status: "posted", $or: [{ direction: "in", source_type: { $in: IN_SOURCES } }, { direction: "out", source_type: { $in: OUT_SOURCES } }] } },
    { $group: { _id: { currency: "$currency", direction: "$direction" }, amount: { $sum: "$amount" } } }
  ]).session(session);
  const openings = await FundsOpening.find({ property_id: propertyId }).session(session).lean();
  return combineFunds(rows, openings);
}
function combineFunds(rows, openings = []) {
  const currencies = new Map();
  for (const row of rows) {
    const item = currencies.get(row._id.currency) || { currency: row._id.currency, received: 0, paid_out: 0, opening_balance: 0, balance: 0 };
    item[row._id.direction === "in" ? "received" : "paid_out"] += row.amount;
    currencies.set(item.currency, item);
  }
  for (const opening of openings) {
    const item = currencies.get(opening.currency) || { currency: opening.currency, received: 0, paid_out: 0, balance: 0 };
    Object.assign(item, { opening_balance: opening.amount, opening_note: opening.note, opening_set_at: opening.created_at, opening_set_by: opening.created_by?.name });
    currencies.set(item.currency, item);
  }
  return [...currencies.values()].map(item => ({ ...item, received: round(item.received), paid_out: round(item.paid_out), opening_balance: round(item.opening_balance || 0), balance: round((item.opening_balance || 0) + item.received - item.paid_out) })).sort((a, b) => a.currency.localeCompare(b.currency));
}
function round(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
module.exports = { recordedFunds, recordedMovement, combineFunds };
