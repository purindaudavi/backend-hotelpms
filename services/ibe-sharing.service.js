const SHARING_DEFAULTS = Object.freeze({
  hotelDetails: true,
  branding: true,
  stayTimes: true,
  policies: true,
  roomDetails: true,
  availability: true,
  bookings: true
});

function sharingFor(settings) {
  return Object.fromEntries(Object.entries(SHARING_DEFAULTS).map(([key, fallback]) => [key, settings?.publicSharing?.[key] ?? fallback]));
}

function requireSharing(settings, permission) {
  if (!sharingFor(settings)[permission]) {
    throw Object.assign(new Error(permission === "bookings"
      ? "Online reservations are currently disabled for this property."
      : "Room availability and rates are currently unavailable for this property."), { statusCode: 403 });
  }
}

module.exports = { SHARING_DEFAULTS, sharingFor, requireSharing };
