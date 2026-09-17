const assert = require("node:assert/strict");
const test = require("node:test");
const FinancialTarget = require("../db_models/financial-target.model");

test("validates and normalizes a monthly net-profit target", async () => {
  const target = new FinancialTarget({ property_id: " hotel-1 ", month: "2026-09", amount: 55209.126, currency: "lkr" });
  await target.validate();
  assert.equal(target.property_id, "hotel-1");
  assert.equal(target.metric, "net_profit");
  assert.equal(target.amount, 55209.13);
  assert.equal(target.currency, "LKR");
});

test("rejects an invalid target month or negative amount", async () => {
  await assert.rejects(new FinancialTarget({ property_id: "hotel-1", month: "Sep 2026", amount: 1 }).validate(), /month/i);
  await assert.rejects(new FinancialTarget({ property_id: "hotel-1", month: "2026-09", amount: -1 }).validate(), /amount/i);
});
