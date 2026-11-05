const express = require("express");
const Invoice = require("../db_models/invoice.model");
const Payment = require("../db_models/reservation-payment.model");
const Expense = require("../db_models/expense.model");
const Purchase = require("../db_models/purchase.model");
const Refund = require("../db_models/refund.model");
const Withdrawal = require("../db_models/withdrawal.model");
const router = express.Router();
router.get("/overview", (req, res, next) => Promise.resolve().then(async () => {
  const propertyId = req.authorizedProperty.property_id;
  const definitions = [
    ["collected", Payment, { status: "posted" }, "$amount"],
    ["outstanding", Invoice, { status: { $in: ["issued", "partially_paid", "paid", "credited"] } }, { $max: [{ $subtract: ["$grand_total", { $add: [{ $ifNull: ["$paid_amount", 0] }, { $ifNull: ["$credited_amount", 0] }] }] }, 0] }],
    ["expenses", Expense, { status: "posted" }, "$amount"],
    ["payables", Purchase, { status: "to_be_paid" }, "$amount"],
    ["pending_refunds", Refund, { status: "pending" }, "$amount"],
    ["pending_withdrawals", Withdrawal, { status: "pending" }, "$amount"]
  ];
  const batches = await Promise.all(definitions.map(async ([key, model, filter, amount]) => ({ key, rows: await model.aggregate([
    { $match: { property_id: propertyId, ...filter } }, { $group: { _id: "$currency", amount: { $sum: amount }, count: { $sum: 1 } } }
  ]) })));
  const currencies = new Map();
  for (const batch of batches) for (const row of batch.rows) {
    const currency = row._id || "LKR", values = currencies.get(currency) || { currency, collected: 0, outstanding: 0, expenses: 0, payables: 0, pending_refunds: 0, pending_withdrawals: 0 };
    values[batch.key] = Math.round((row.amount + Number.EPSILON) * 100) / 100; currencies.set(currency, values);
  }
  res.json({ as_of: new Date(), currencies: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)) });
}).catch(next));
module.exports = router;
