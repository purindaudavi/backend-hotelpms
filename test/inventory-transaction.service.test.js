const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const InventoryGuard = require("../db_models/inventory-guard.model");
const { withInventoryTransaction } = require("../services/inventory-transaction.service");

function setup(t, { initializeError, guardResult = { matchedCount: 1 }, transactionError, attempts = 1 } = {}) {
  const events = [];
  const session = {
    async withTransaction(callback, options) {
      events.push({ action: "transaction", options });
      if (transactionError) throw transactionError;
      let result;
      for (let index = 0; index < attempts; index++) result = await callback();
      return result;
    },
    async endSession() { events.push({ action: "end" }); }
  };
  t.mock.method(InventoryGuard, "updateOne", async (filter, update, options) => {
    events.push({ action: options.session ? "guard" : "initialize", filter, update, options });
    if (!options.session && initializeError) throw initializeError;
    return guardResult;
  });
  t.mock.method(mongoose, "startSession", async () => {
    events.push({ action: "session" });
    return session;
  });
  return { events, session };
}

test("writes the unique property guard before work and commits with snapshot/majority", async (t) => {
  const { events, session } = setup(t);
  const result = await withInventoryTransaction(" hotel-one ", async (value) => {
    assert.equal(value, session);
    events.push({ action: "work" });
    return "saved";
  });
  assert.equal(result, "saved");
  assert.deepEqual(events.map((item) => item.action), ["initialize", "session", "transaction", "guard", "work", "end"]);
  assert.deepEqual(events[0].filter, { _id: "hotel-one" });
  assert.equal(events[0].options.upsert, true);
  assert.deepEqual(events[3].update, { $inc: { revision: 1 } });
  assert.equal(events[3].options.session, session);
  assert.deepEqual(events[2].options.readConcern, { level: "snapshot" });
  assert.deepEqual(events[2].options.writeConcern, { w: "majority" });
  assert.equal(events[2].options.readPreference, "primary");
  assert.equal(events[2].options.timeoutMS, 15000);
});

test("different hotels use different guard IDs", async (t) => {
  const { events } = setup(t);
  await withInventoryTransaction("hotel-one", async () => {});
  await withInventoryTransaction("hotel-two", async () => {});
  assert.deepEqual(events.filter((item) => item.action === "guard").map((item) => item.filter._id), ["hotel-one", "hotel-two"]);
});

test("a duplicate guard bootstrap is safe on concurrent first use", async (t) => {
  setup(t, { initializeError: Object.assign(new Error("duplicate"), { code: 11000 }) });
  assert.equal(await withInventoryTransaction("hotel-one", async () => 42), 42);
});

test("initialization failure cannot fall back to unprotected work", async (t) => {
  const error = new Error("database unavailable");
  const { events } = setup(t, { initializeError: error });
  await assert.rejects(withInventoryTransaction("hotel-one", async () => assert.fail("must not run")), (value) => value === error);
  assert.deepEqual(events.map((item) => item.action), ["initialize"]);
});

test("a missing guard fails closed and closes its session", async (t) => {
  const { events } = setup(t, { guardResult: { matchedCount: 0 } });
  await assert.rejects(withInventoryTransaction("hotel-one", async () => assert.fail("must not run")), { statusCode: 503 });
  assert.equal(events.at(-1).action, "end");
});

test("transaction retries repeat the guard before fresh business work", async (t) => {
  const { events } = setup(t, { attempts: 2 });
  let count = 0;
  assert.equal(await withInventoryTransaction("hotel-one", async () => {
    events.push({ action: "work" });
    return ++count;
  }), 2);
  assert.deepEqual(events.filter((item) => ["guard", "work"].includes(item.action)).map((item) => item.action), ["guard", "work", "guard", "work"]);
});

test("business rejection is preserved and session is released", async (t) => {
  const { events } = setup(t);
  const error = Object.assign(new Error("No rooms available"), { statusCode: 409 });
  await assert.rejects(withInventoryTransaction("hotel-one", async () => { throw error; }), (value) => value === error);
  assert.equal(events.at(-1).action, "end");
});

for (const name of ["MongoOperationTimeoutError", "TransientTransactionError", "UnknownTransactionCommitResult"]) {
  test(`${name} never acknowledges a successful save`, async (t) => {
    const error = Object.assign(new Error(name), { name, hasErrorLabel: (label) => label === name });
    const { events } = setup(t, { transactionError: error });
    await assert.rejects(withInventoryTransaction("hotel-one", async () => assert.fail("must not run")), { statusCode: 503 });
    assert.equal(events.at(-1).action, "end");
  });
}

test("a database without transaction support cannot save unprotected", async (t) => {
  const error = Object.assign(new Error("Transactions require a replica set"), { code: 20 });
  setup(t, { transactionError: error });
  await assert.rejects(withInventoryTransaction("hotel-one", async () => assert.fail("must not run")), (value) => value === error);
});

test("invalid property IDs are rejected before touching the database", async (t) => {
  const { events } = setup(t);
  for (const propertyId of [undefined, {}, "", "   ", "a".repeat(101)]) {
    await assert.rejects(withInventoryTransaction(propertyId, async () => assert.fail("must not run")), { statusCode: 400 });
  }
  assert.equal(events.length, 0);
});
