const assert = require("node:assert/strict");
const test = require("node:test");
const Purchase = require("../db_models/purchase.model");
const Expense = require("../db_models/expense.model");

test("purchase validates payable data", async () => {
  const purchase = new Purchase({
    property_id: "demo",
    purchase_no: "pur-2026-000001",
    supplier_name: "ABC Foods",
    supplier_invoice_no: "SUP-100",
    purchase_date: new Date("2026-08-14"),
    due_date: new Date("2026-08-20"),
    amount: 1200.555,
    currency: "lkr"
  });
  await purchase.validate();
  assert.equal(purchase.purchase_no, "PUR-2026-000001");
  assert.equal(purchase.amount, 1200.56);
  assert.equal(purchase.status, "to_be_paid");
});

test("purchase rejects a due date before its purchase date", async () => {
  const purchase = new Purchase({
    property_id: "demo",
    purchase_no: "PUR-2026-000002",
    supplier_name: "ABC Foods",
    supplier_invoice_no: "SUP-101",
    purchase_date: new Date("2026-08-20"),
    due_date: new Date("2026-08-14"),
    amount: 100,
    currency: "LKR"
  });
  await assert.rejects(purchase.validate(), /cannot be before/);
});

test("expense validates posted money-out data", async () => {
  const expense = new Expense({
    property_id: "demo",
    expense_no: "exp-2026-000001",
    expense_date: new Date("2026-08-14"),
    expense_type: "Electricity",
    paid_using: "Cash Account",
    amount: 2500,
    currency: "lkr"
  });
  await expense.validate();
  assert.equal(expense.expense_no, "EXP-2026-000001");
  assert.equal(expense.currency, "LKR");
  assert.equal(expense.status, "posted");
});
