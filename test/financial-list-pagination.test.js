const test = require("node:test"), assert = require("node:assert/strict"), express = require("express");
for (const [name, path, Model] of [["Purchases", "purchases", require("../db_models/purchase.model")], ["Expenses", "expenses", require("../db_models/expense.model")]]) {
  test(`${name} supports complete paginated comparison lists and preserves the old unpaginated response`, async t => {
    const rows = Array.from({ length: 3 }, (_, index) => ({ toObject() { return { _id: `row-${index}`, property_id: "finance-pagination", amount: index + 1 }; } }));
    t.mock.method(Model, "find", filter => { assert.equal(filter.property_id, "finance-pagination"); let skip = 0; return { sort() { return this; }, skip(value) { skip = value; return this; }, limit(value) { return Promise.resolve(rows.slice(skip, skip + value)); } }; });
    t.mock.method(Model, "countDocuments", filter => { assert.equal(filter.property_id, "finance-pagination"); return Promise.resolve(rows.length); });
    const app = express(); app.use(`/${path}`, require(`../routes/${path}`));
    const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const call = async query => { const result = await fetch(`http://127.0.0.1:${server.address().port}/${path}?property_id=finance-pagination${query}`); assert.equal(result.status, 200); return result.json(); };
    const original = await call(""); assert.equal(original.count, 3); assert.equal(original.pages, undefined); assert.equal(original.total, undefined);
    const first = await call("&page=1&limit=2"); assert.equal(first.count, 2); assert.equal(first.total, 3); assert.equal(first.pages, 2);
    const second = await call("&page=2&limit=2"); assert.equal(second.count, 1); assert.equal(second[path][0]._id, "row-2");
  });
}
