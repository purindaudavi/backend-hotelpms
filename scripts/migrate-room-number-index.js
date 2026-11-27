require("dotenv").config({ quiet: true });
const { MongoClient } = require("mongodb");
const { migrateRoomNumberIndex } = require("../services/room-index.service");

async function main() {
  if (process.argv.slice(2).some(arg => arg !== "--apply")) throw new Error("Usage: node scripts/migrate-room-number-index.js [--apply]");
  const uri = process.env.mongoURI || process.env.MONGO_URI;
  if (!uri) throw new Error("mongoURI is required in the environment.");
  // Use the native driver: Mongoose auto-indexing must not mutate other indexes.
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const collection = client.db().collection("room_types");
    const result = await migrateRoomNumberIndex(collection, { apply: process.argv.includes("--apply") });
    console.log(JSON.stringify({ collection: "room_types", ...result }, null, 2));
    console.log(result.apply
      ? "Room-number indexes verified. No room, booking, rate or invoice records were changed."
      : "Preview only. Add --apply to migrate these indexes.");
  } finally { await client.close(); }
}

main().catch(error => {
  // Avoid printing connection strings or credentials from driver errors.
  console.error(`Room-number index migration failed (${error.name}${error.code ? `, code ${error.code}` : ""}).`);
  if (!error.name?.startsWith("Mongo")) console.error(error.message);
  process.exitCode = 1;
});
