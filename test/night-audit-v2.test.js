const test = require("node:test"), assert = require("node:assert/strict");
const { dailyCharges, portion, receiptSummary } = require("../services/night-audit-v2.service");
test("night audit identifies an issued owner override as an additional invoice", () => {
  const stay = { _id: "r", reservation_no: "RES-1" };
  const original = { _id: "original", invoice_no: "INV-1", currency: "LKR", status: "issued",
    stay_snapshot: { check_in: "2026-11-10", check_out: "2026-11-11" },
    line_items: [{ _id: "room", source_type: "accommodation", net_amount: 6500 }] };
  const draft = { ...original, _id: "extra", invoice_no: "INV-2", status: "draft", stay_override: { invoice_no: original.invoice_no } };
  assert.equal(dailyCharges(stay, [original, draft], "2026-11-10").length, 1);
  const charges = dailyCharges(stay, [original, { ...draft, status: "issued" }], "2026-11-10");
  assert.deepEqual(charges.map(charge => charge.total), [6500, 6500]);
  assert.match(charges[1].basis, /Owner-approved.*INV-1/);
});
test("v2 allocations reuse issued invoice room/meal charges, tax and credits without treating receipts as revenue", () => {
  const reservation = { _id: "r", reservation_no: "RES-1", booker: { name: "Guest" } };
  const invoice = { _id: "i", invoice_no: "INV-1", currency: "LKR", status: "paid", grand_total: 14300, credited_amount: 1430,
    stay_snapshot: { check_in: "2026-11-10", check_out: "2026-11-12" }, line_items: [{ _id: "line", source_type: "accommodation", net_amount: 13000, tax_amount: 1300 }] };
  const a = dailyCharges(reservation, [invoice], "2026-11-10"), b = dailyCharges(reservation, [invoice], "2026-11-11");
  assert.equal(a[0].net, 6500); assert.equal(a[0].tax, 650); assert.equal(a[0].credit, 715); assert.equal(a[0].total + b[0].total, 12870);
  assert.equal(dailyCharges(reservation, [invoice], "2026-11-12").length, 0);
  assert.equal(dailyCharges(reservation, [{ ...invoice, status: "draft" }], "2026-11-10").length, 0);
  assert.equal(dailyCharges(reservation, [{ ...invoice, stay_snapshot: { check_in: "2026-11-10", check_out: "2026-11-10", is_day_room: true } }], "2026-11-10")[0].total, 12870);
});
test("v2 allocation distributes remainder cents exactly once and separates payment currencies/methods", () => {
  assert.equal([0, 1, 2].reduce((n, i) => n + Math.round(portion(100, 3, i) * 100), 0), 10000);
  const groups = receiptSummary([{ currency: "LKR", payment_method: "cash", amount: 100 }, { currency: "LKR", payment_method: "cash", amount: 50 }, { currency: "USD", payment_method: "cash", amount: 5 }, { currency: "LKR", payment_method: "credit_card", amount: 50 }]);
  assert.equal(groups.length, 3); assert.equal(groups.find(g => g.key === "LKR:cash").expected, 150);
});
