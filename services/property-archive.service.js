const Guard = require("../db_models/inventory-guard.model");

// Caller must hold this property's inventory transaction guard. Lifecycle and
// guarded booking/finance writes then serialize, including archive approvals.
async function setPropertyArchived(record, archived, actor, reason, session) {
  record.status = archived ? "inactive" : "active";
  record.platform_archived_at = archived ? new Date() : null;
  record.platform_archived_by = archived ? actor : {};
  record.platform_archive_reason = archived ? reason : "";
  await Guard.updateOne({ _id: record.property_id }, { $set: { property_archived: archived } }, { session });
}
module.exports = { setPropertyArchived };
