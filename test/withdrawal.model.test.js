const test = require("node:test");
const assert = require("node:assert/strict");
const Withdrawal = require("../db_models/withdrawal.model");

function validWithdrawal(overrides = {}) {
  return new Withdrawal({
    property_id: " demo ",
    withdrawal_no: "wd-2026-000001",
    paid_to: "ASIRI PERERA",
    amount: 2500.129,
    currency: "lkr",
    source_account: "Cash on hand",
    payment_method: "Bank transfer",
    reason: "Owner cash withdrawal",
    money_received_at: new Date("2026-08-13T08:00:00.000Z"),
    ...overrides
  });
}

test("withdrawal normalizes money, currency and enum values", async () => {
  const withdrawal = validWithdrawal();
  await withdrawal.validate();
  assert.equal(withdrawal.property_id, "demo");
  assert.equal(withdrawal.withdrawal_no, "WD-2026-000001");
  assert.equal(withdrawal.amount, 2500.13);
  assert.equal(withdrawal.currency, "LKR");
  assert.equal(withdrawal.source_account, "cash_on_hand");
  assert.equal(withdrawal.payment_method, "bank_transfer");
  assert.equal(withdrawal.status, "completed");
});

test("withdrawal requires a positive amount, reason and received date", async () => {
  const withdrawal = validWithdrawal({ amount: 0, reason: "", money_received_at: undefined });
  await assert.rejects(withdrawal.validate(), (error) => {
    assert.ok(error.errors.amount);
    assert.ok(error.errors.reason);
    assert.ok(error.errors.money_received_at);
    return true;
  });
});

test("withdrawal has no approval or selectable withdrawal-type fields", () => {
  assert.equal(Withdrawal.schema.path("approval_status"), undefined);
  assert.equal(Withdrawal.schema.path("withdrawal_type"), undefined);
  assert.ok(Withdrawal.schema.path("reason"));
});
