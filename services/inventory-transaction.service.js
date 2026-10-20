const mongoose = require("mongoose");
const InventoryGuard = require("../db_models/inventory-guard.model");

async function withInventoryTransaction(propertyId, work) {
  if (typeof propertyId !== "string" || !propertyId.trim() || propertyId.length > 100) {
    throw Object.assign(new Error("A property ID is required to protect inventory."), { statusCode: 400 });
  }
  propertyId = propertyId.trim();

  // Bootstrap outside the transaction. Concurrent first-use requests may race
  // to insert this same unique _id; that duplicate only means it already exists.
  try {
    await InventoryGuard.updateOne(
      { _id: propertyId }, { $setOnInsert: { revision: 0 } },
      { upsert: true, writeConcern: { w: "majority" }, maxTimeMS: 10000 }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      // This MUST be the first database operation in every callback attempt,
      // before reading reservations, block pickup counts, room links or rooms.
      // A concurrent writer conflicts here. The driver retries the entire
      // callback with a fresh snapshot after the winning transaction commits.
      const result = await InventoryGuard.updateOne(
        { _id: propertyId }, { $inc: { revision: 1 } }, { session }
      );
      if (result.matchedCount !== 1) {
        throw Object.assign(new Error("Inventory protection is unavailable. Please try again."), { statusCode: 503 });
      }
      return work(session);
    }, {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
      readPreference: "primary", timeoutMS: 15000
    });
  } catch (error) {
    // Never fall back to an unprotected save if transactions are unsupported
    // or contention outlasts the retry budget.
    if (error.name === "MongoOperationTimeoutError" ||
        error.hasErrorLabel?.("TransientTransactionError") ||
        error.hasErrorLabel?.("UnknownTransactionCommitResult")) {
      throw Object.assign(new Error("Inventory is busy or the save result is uncertain. Refresh bookings before trying again."), {
        statusCode: 503, cause: error
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = { withInventoryTransaction };
