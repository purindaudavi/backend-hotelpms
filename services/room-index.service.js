const RoomType = require("../db_models/rooms.model");

const LEGACY_INDEX_NAME = "unique_physical_room_number_per_property";
const [ROOM_NUMBER_KEY, schemaOptions] = RoomType.schema.indexes().find(([key]) => key["physical_rooms.room_number"] === 1);
const ROOM_NUMBER_OPTIONS = {
  name: schemaOptions.name,
  unique: true,
  partialFilterExpression: schemaOptions.partialFilterExpression
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function validReplacement(index) {
  return index && same(index.key, ROOM_NUMBER_KEY) && index.unique === true && !index.sparse &&
    same(index.partialFilterExpression, ROOM_NUMBER_OPTIONS.partialFilterExpression);
}

async function migrateRoomNumberIndex(collection, { apply = false } = {}) {
  const indexes = await collection.indexes();
  const legacy = indexes.find(index => index.name === LEGACY_INDEX_NAME);
  const replacement = indexes.find(index => index.name === ROOM_NUMBER_OPTIONS.name);
  if (legacy && (!same(legacy.key, ROOM_NUMBER_KEY) || legacy.unique !== true || legacy.sparse !== true || legacy.partialFilterExpression)) {
    throw new Error("The legacy room-number index has an unexpected definition. No indexes were removed.");
  }
  if (replacement && !validReplacement(replacement)) {
    throw new Error("The replacement room-number index has an unexpected definition. No indexes were removed.");
  }
  const result = { apply, needsMigration: !replacement || Boolean(legacy),
    replacement: ROOM_NUMBER_OPTIONS.name, createReplacement: !replacement, removeLegacy: Boolean(legacy) };
  if (!apply) return result;

  // Build and verify the replacement BEFORE removing the old constraint.
  // A failed build leaves the old unique index protecting all existing data.
  await collection.createIndex(ROOM_NUMBER_KEY, ROOM_NUMBER_OPTIONS);
  const ready = (await collection.indexes()).find(index => index.name === ROOM_NUMBER_OPTIONS.name);
  if (!validReplacement(ready)) throw new Error("The replacement room-number index could not be verified. The legacy index was retained.");
  if (legacy) await collection.dropIndex(LEGACY_INDEX_NAME);
  const finalIndexes = await collection.indexes();
  if (!validReplacement(finalIndexes.find(index => index.name === ROOM_NUMBER_OPTIONS.name)) ||
      finalIndexes.some(index => index.name === LEGACY_INDEX_NAME)) {
    throw new Error("Room-number index migration did not reach the expected state. Inspect the collection indexes.");
  }
  return { ...result, needsMigration: false };
}

module.exports = { migrateRoomNumberIndex, ROOM_NUMBER_KEY, ROOM_NUMBER_OPTIONS, LEGACY_INDEX_NAME };
