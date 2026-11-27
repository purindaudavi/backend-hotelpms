const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateRoomNumberIndex, ROOM_NUMBER_KEY, ROOM_NUMBER_OPTIONS, LEGACY_INDEX_NAME } = require("../services/room-index.service");

function fixture({ legacy = true, replacement = false, failBuild = false, unverifiable = false } = {}) {
  const calls = [];
  let indexes = [{ name: "unrelated_index", key: { active: 1 } },
    ...(legacy ? [{ name: LEGACY_INDEX_NAME, key: ROOM_NUMBER_KEY, unique: true, sparse: true }] : []),
    ...(replacement ? [{ key: ROOM_NUMBER_KEY, ...ROOM_NUMBER_OPTIONS }] : [])];
  return { calls, collection: {
    indexes: async () => structuredClone(indexes),
    createIndex: async (key, options) => {
      calls.push(["create", key, options]);
      if (failBuild) throw new Error("Index build failed");
      if (!indexes.some(index => index.name === options.name) && !unverifiable) indexes.push({ key, ...options });
    },
    dropIndex: async name => { calls.push(["drop", name]); indexes = indexes.filter(index => index.name !== name); }
  } };
}

test("preview lists required changes without writing indexes", async () => {
  const { collection, calls } = fixture();
  const result = await migrateRoomNumberIndex(collection);
  assert.equal(result.needsMigration, true); assert.equal(result.removeLegacy, true);
  assert.deepEqual(calls, []);
});

test("migration builds the partial unique index before removing only the legacy index", async () => {
  const { collection, calls } = fixture();
  const result = await migrateRoomNumberIndex(collection, { apply: true });
  assert.equal(result.needsMigration, false);
  assert.deepEqual(calls.map(call => call[0]), ["create", "drop"]);
  assert.deepEqual(calls[0][2].partialFilterExpression, { "physical_rooms.room_number": { $type: "string" } });
  assert.equal(calls[0][2].unique, true); assert.equal(calls[0][2].sparse, undefined);
  assert.deepEqual((await collection.indexes()).map(index => index.name), ["unrelated_index", ROOM_NUMBER_OPTIONS.name]);
});

test("failed or unverifiable replacement leaves the old unique constraint in place", async () => {
  for (const options of [{ failBuild: true }, { unverifiable: true }]) {
    const { collection, calls } = fixture(options);
    await assert.rejects(migrateRoomNumberIndex(collection, { apply: true }));
    assert.equal(calls.some(call => call[0] === "drop"), false);
    assert.ok((await collection.indexes()).some(index => index.name === LEGACY_INDEX_NAME));
  }
});

test("migration is safe to rerun after an interrupted or completed migration", async () => {
  for (const legacy of [true, false]) {
    const { collection } = fixture({ legacy, replacement: true });
    await migrateRoomNumberIndex(collection, { apply: true });
    assert.equal((await migrateRoomNumberIndex(collection)).needsMigration, false);
  }
});

test("unexpected definitions are rejected without removing constraints", async () => {
  for (const index of [
    { name: LEGACY_INDEX_NAME, key: { another_field: 1 }, unique: true, sparse: true },
    { name: ROOM_NUMBER_OPTIONS.name, key: ROOM_NUMBER_KEY, unique: false }
  ]) {
    let writes = 0;
    await assert.rejects(migrateRoomNumberIndex({ indexes: async () => [index],
      createIndex: async () => { writes++; }, dropIndex: async () => { writes++; } }, { apply: true }), /unexpected definition/);
    assert.equal(writes, 0);
  }
});
