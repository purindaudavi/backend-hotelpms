// Keep form errors distinct from inventory conflicts: invalid guest details
// must never be presented as an overlapping booking.
function bookingValidationMessage(error) {
  const entries = Object.entries(error.errors || {});
  const errors = entries.map(([, value]) => value);
  const first = errors[0] || error;
  // Mongoose's nested ValidatorError.path can be just "email"; the parent
  // errors key retains the useful full path, e.g. "booker.email".
  const path = String(entries[0]?.[0] || first.path || "");

  if (errors.some((item) => /references a reservation room that does not exist/i.test(item.message || ""))) {
    return "Room and guest selections do not match. Reopen the reservation, check the details and try again.";
  }

  if (first.name === "CastError" || error.name === "BSONError") {
    if (/room|allocation|rate_plan/i.test(path) || error.name === "BSONError") {
      return "Please reselect the room and rate plan, then try again.";
    }
    if (/check_in|check_out|date/i.test(path)) {
      return "Please check the reservation dates and try again.";
    }
    return "Please check the selected reservation details and try again.";
  }

  const fields = {
    "booker.name": "the guest name",
    "booker.email": "the guest email address",
    "booker.phone": "the guest phone number",
    "booker.country": "the guest country",
    check_in: "the check-in date",
    check_out: "the check-out date",
    reservation_date: "the reservation date",
    currency: "the reservation currency"
  };
  if (fields[path]) return `Please check ${fields[path]} and try again.`;
  if (/^rooms(?:\.|$)/.test(path)) return "Please check the selected rooms and guest counts, then try again.";
  if (/^occupants(?:\.|$)/.test(path)) return "Please check the guest list and room assignments, then try again.";
  return "Please check the reservation details and try again.";
}

module.exports = { bookingValidationMessage };
