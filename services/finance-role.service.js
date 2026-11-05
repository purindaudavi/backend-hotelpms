// Explicit billing projection: never return occupant identity documents,
// attachments, internal remarks or operational update controls to Finance.
function billingReservation(record) {
  const raw = record.toObject ? record.toObject() : record;
  const fields = ["_id", "property_id", "reservation_no", "booking_reference", "booking_source", "status", "check_in", "check_out", "is_day_use", "currency", "rate_plan_id", "rate_plan_name", "meal_plan", "created_at", "financial_summary", "travel_agent"];
  const result = Object.fromEntries(fields.filter(field => raw[field] !== undefined).map(field => [field, raw[field]]));
  result.booker = { name: raw.booker?.name || "", email: raw.booker?.email || "", phone: raw.booker?.phone || "", country: raw.booker?.country || "" };
  result.rooms = (raw.rooms || []).map(room => Object.fromEntries(["_id", "room_type_id", "room_type_name", "physical_room_id", "room_number", "adults", "children", "original_nightly_rate", "effective_nightly_rate", "currency", "meal_plan", "complimentary"].filter(field => room[field] !== undefined).map(field => [field, room[field]])));
  return result;
}
module.exports = { billingReservation };
