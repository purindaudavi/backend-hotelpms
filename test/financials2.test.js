const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const path = require("node:path");
const frontend = process.env.PMS_FRONTEND_PATH || path.resolve(__dirname, "../../new-pms");
if (!fs.existsSync(path.join(frontend, "node_modules/typescript"))) {
  test("Financials 2 companion frontend checks", { skip: "Companion PMS frontend and its TypeScript dependency are required." }, () => {});
} else {
const typescript = require(path.join(frontend, "node_modules/typescript"));
function load(file) {
  const source = fs.readFileSync(path.join(frontend, file), "utf8");
  const code = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } }).outputText;
  const exports = {}; vm.runInNewContext(code, { exports, require, Date, Map, Set, Object, Number }); return exports;
}
const { buildActivity, summarizeFinance, emptyFinanceData, invoiceOwing, activityMatchesStatus, supplierPaymentMethod } = load("app/components/modules/financials2/financials2-data.ts");
const { canOpenPropertyPage } = load("app/lib/property-permissions.ts");
const invoice = { _id: "inv", invoice_no: "INV-1", invoice_date: "2026-11-01", due_date: "2026-11-02", billing_snapshot: { name: "Guest" }, reservation_id: "res", reservation_no: "RES-1", currency: "LKR", status: "partially_paid", grand_total: 13000, paid_amount: 5000, credited_amount: 2000, balance_due: 6000, refund_due: 0 };
const transaction = (source_type, source_id, amount, direction, currency = "LKR", status = "posted") => ({ _id: `${source_type}-${source_id}`, source_type, source_id, amount, direction, currency, status, source_number: "INV-1", transaction_no: "TX-1", transaction_date: "2026-11-01", reservation_id: "res", reservation_no: "RES-1", description: "Recorded event" });
test("Financials 2 carries saved Other payment details into activity and retains legacy display", () => {
  const purchase = { _id: "wallet-bill", purchase_no: "PUR-WALLET", purchase_date: "2026-11-06", supplier_name: "Supplier", amount: 100, currency: "LKR", status: "paid", payment_method: "other", payment_method_details: "Mobile wallet" };
  const row = buildActivity({ ...emptyFinanceData, purchases: [purchase], transactions: [transaction("supplier_payment", purchase._id, 100, "out")] }).find(item => item.kind === "supplier_payment");
  assert.equal(row.paymentMethod, "Other — Mobile wallet");
  assert.equal(supplierPaymentMethod({ ...purchase, payment_method_details: undefined }), "Other (not specified)");
  assert.equal(supplierPaymentMethod({ ...purchase, payment_method: "bank_transfer" }), "Bank Transfer");
  assert.equal(supplierPaymentMethod({ ...purchase, payment_method: undefined }), "Not specified");
});
test("Financials 2 separates a bill's posted event from its current paid/unpaid state", () => {
  const bill = { _id: "supplier-bill", purchase_no: "PUR-1", purchase_date: "2026-11-06", supplier_name: "Linen", status: "to_be_paid", amount: 2000, currency: "LKR" };
  const data = { ...emptyFinanceData, purchases: [bill], transactions: [transaction("purchase", bill._id, 2000, "non_cash")] };
  let row = buildActivity(data)[0];
  assert.equal(row.status, "posted"); assert.equal(row.paymentStatus, "unpaid");
  assert.equal(activityMatchesStatus(row, "posted"), true);
  assert.equal(activityMatchesStatus(row, "unpaid"), true);
  assert.equal(activityMatchesStatus(row, "paid"), false);
  bill.status = "paid";
  data.transactions.push(transaction("supplier_payment", bill._id, 2000, "out"));
  const rows = buildActivity(data); row = rows.find(item => item.kind === "purchase");
  assert.equal(row.status, "posted"); assert.equal(row.paymentStatus, "paid");
  assert.equal(activityMatchesStatus(row, "paid"), true);
  assert.equal(activityMatchesStatus(row, "unpaid"), false);
  assert.equal(rows.find(item => item.kind === "supplier_payment").paymentStatus, undefined);
  assert.equal(summarizeFinance(data)[0].spent, 2000);
});
test("Financials 2 shows unpaid state for a bill without a transaction and never guesses for missing or voided bills", () => {
  const bill = { _id: "unposted-bill", purchase_no: "PUR-2", purchase_date: "2026-11-06", supplier_name: "Linen", status: "to_be_paid", amount: 100, currency: "LKR" };
  assert.equal(buildActivity({ ...emptyFinanceData, purchases: [bill] })[0].paymentStatus, "unpaid");
  assert.equal(buildActivity({ ...emptyFinanceData, purchases: [{ ...bill, status: "voided" }] })[0].paymentStatus, undefined);
  const missing = buildActivity({ ...emptyFinanceData, transactions: [transaction("purchase", "missing", 100, "non_cash")] })[0];
  assert.equal(missing.paymentStatus, undefined); assert.equal(activityMatchesStatus(missing, "unpaid"), false);
});
test("Financials 2 puts a newly recorded same-day bill above older bills and payments", () => {
  const bill = { ...transaction("purchase", "cbc", 100, "non_cash"), _id: "a-new", transaction_date: "2026-11-06T00:00:00.000Z", created_at: "2026-11-06T06:12:00.000Z" };
  const previousBill = { ...transaction("purchase", "towels", 2000, "non_cash"), _id: "z-old", transaction_date: "2026-11-06T00:00:00.000Z", created_at: "2026-11-06T04:00:00.000Z", updated_at: "2026-11-06T07:00:00.000Z" };
  const payment = { ...transaction("supplier_payment", "towels", 2000, "out"), _id: "y-payment", transaction_date: "2026-11-06T05:00:00.000Z", created_at: "2026-11-06T05:00:00.000Z" };
  const data = { ...emptyFinanceData, transactions: [previousBill, payment, bill] };
  assert.deepEqual(Array.from(buildActivity(data), row => row.id + ":" + row.kind), ["cbc:purchase", "towels:supplier_payment", "towels:purchase"]);
  assert.equal(summarizeFinance(data)[0].spent, 2000);
});
test("Financials 2 sorts unposted documents by creation time within their financial day and falls back for legacy records", () => {
  const old = { ...invoice, _id: "old", invoice_date: "2026-11-05", created_at: "2026-11-07T10:00:00.000Z" };
  const sameDay = { ...invoice, _id: "same", invoice_date: "2026-11-06", created_at: "2026-11-06T09:00:00.000Z" };
  const purchase = { _id: "bill", purchase_no: "PUR-NEW", purchase_date: "2026-11-06", created_at: "2026-11-06T10:00:00.000Z", supplier_name: "cbc", supplier_invoice_no: "CBC-1", amount: 100, currency: "LKR", status: "to_be_paid" };
  const data = { ...emptyFinanceData, invoices: [old, sameDay], purchases: [purchase] };
  assert.deepEqual(Array.from(buildActivity(data), row => row.id), ["bill", "same", "old"]);
  const legacy = { ...emptyFinanceData, transactions: [
    { ...transaction("payment", "early", 100, "in"), transaction_date: "2026-11-06T08:00:00.000Z", created_at: "invalid" },
    { ...transaction("payment", "late", 100, "in"), transaction_date: "2026-11-06T09:00:00.000Z" }
  ] };
  assert.deepEqual(Array.from(buildActivity(legacy), row => row.id), ["late", "early"]);
});
test("Financials 2 keeps invoice, payment, credit and pending requests distinct without counting documents twice", () => {
  const data = { ...emptyFinanceData, invoices: [invoice], credits: [{ _id: "cn", invoice_id: "inv", credit_note_no: "CN-1", credit_date: "2026-11-01", currency: "LKR", status: "draft", total_credit: 2000, reason: "Overcharge", guest_snapshot: { name: "Guest" } }], withdrawals: [{ _id: "wd", withdrawal_no: "WD-1", status: "pending", requested_at: "2026-11-01", amount: 4000, currency: "LKR", paid_to: "Owner", reason: "Owner request" }], transactions: [transaction("invoice", "inv", 13000, "non_cash"), transaction("payment", "pay", 5000, "in")] };
  const rows = buildActivity(data);
  assert.equal(rows.length, 4); assert.equal(rows.filter(row => row.kind === "invoice").length, 1);
  assert.equal(rows.find(row => row.kind === "payment").invoiceId, "inv");
  assert.equal(rows.find(row => row.kind === "credit_note").direction, "non_cash");
  const totals = summarizeFinance(data)[0];
  assert.equal(totals.received, 5000); assert.equal(totals.outstanding, 6000); assert.equal(totals.pending, 4000); assert.equal(totals.withdrawn, 0);
});
test("Financials 2 cash totals exclude invoice revenue, credits, supplier bills, Night Audit inflows and voided payments", () => {
  const data = { ...emptyFinanceData, transactions: [transaction("invoice", "i", 13000, "non_cash"), transaction("credit_note", "c", 2000, "non_cash"), transaction("night_audit", "n", 6500, "in"), transaction("purchase", "b", 20000, "non_cash"), transaction("payment", "p", 5000, "in"), transaction("payment", "void", 2000, "in", "LKR", "voided"), transaction("supplier_payment", "b", 20000, "out"), transaction("expense", "e", 1000, "out"), transaction("refund", "r", 500, "out"), transaction("withdrawal", "w", 3000, "out")] };
  const totals = summarizeFinance(data)[0]; assert.equal(totals.received, 5000); assert.equal(totals.spent, 21000); assert.equal(totals.refunded, 500); assert.equal(totals.withdrawn, 3000);
  assert.equal(buildActivity(data).find(row => row.kind === "night_audit").direction, "review");
});
test("Financials 2 keeps currencies separate and applies date filters to movements", () => {
  const data = { ...emptyFinanceData, transactions: [transaction("payment", "lkr", 5000, "in"), transaction("payment", "usd", 100, "in", "USD"), { ...transaction("payment", "old", 7000, "in"), transaction_date: "2026-10-01" }] };
  const all = summarizeFinance(data, "2026-11-01", "2026-11-05");
  assert.equal(all.length, 2); assert.equal(all.find(row => row.currency === "LKR").received, 5000); assert.equal(all.find(row => row.currency === "USD").received, 100);
  assert.equal(summarizeFinance(data, "2026-11-01", "2026-11-05", "USD").length, 1);
});
test("Financials 2 unpaid guest invoices exclude drafts, voids and fully credited bills", () => {
  assert.ok(invoiceOwing(invoice));
  for (const status of ["draft", "voided", "credited"]) assert.equal(invoiceOwing({ ...invoice, status }), false);
  assert.equal(invoiceOwing({ ...invoice, status: "paid", balance_due: 0 }), false);
});
test("Financials 2 follows Finance/Owner/Admin access without widening Front Desk or Housekeeping", () => {
  for (const role of ["owner", "administrator", "finance"]) assert.ok(canOpenPropertyPage(role, [], "financials-2"));
  for (const role of ["front_desk", "housekeeping", "demo", null]) assert.equal(canOpenPropertyPage(role, [], "financials-2"), false);
  assert.ok(canOpenPropertyPage("member", ["operations.manage"], "financials-2"));
  assert.ok(canOpenPropertyPage("front_desk", [], "financials/invoices"));
  assert.equal(canOpenPropertyPage("front_desk", [], "financials/expenses"), false);
});
}
