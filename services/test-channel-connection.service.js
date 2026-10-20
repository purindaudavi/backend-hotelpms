const RoomType = require("../db_models/rooms.model");
const RatePlan = require("../db_models/rates.model");
const Reservation = require("../db_models/booking.model");

const PROVIDER = "dms-test-channel";

function configuration(propertyId) {
  if (process.env.NODE_ENV === "production") return { available: false, reason: "The test channel is disabled in production." };
  const configuredProperty = String(process.env.TEST_CHANNEL_PROPERTY_ID || "").trim();
  const key = String(process.env.TEST_CHANNEL_API_KEY || "");
  if (!configuredProperty || key.length < 16) {
    return { available: false, reason: "Configure TEST_CHANNEL_PROPERTY_ID and TEST_CHANNEL_API_KEY on the PMS backend." };
  }
  if (configuredProperty !== propertyId) return { available: false, reason: "The test channel is not enabled for this property." };
  let url;
  try { url = new URL(process.env.TEST_CHANNEL_URL || "http://127.0.0.1:3601"); }
  catch { return { available: false, reason: "TEST_CHANNEL_URL must be a local http://127.0.0.1 address." }; }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return { available: false, reason: "TEST_CHANNEL_URL must be a local http://127.0.0.1 address." };
  }
  return { available: true, url: url.origin, key };
}

async function requestChannel(config, propertyId, method, body) {
  let response;
  try {
    response = await fetch(`${config.url}/v1/properties/${encodeURIComponent(propertyId)}/snapshot`, {
      method,
      headers: { "x-test-channel-key": config.key, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    const error = new Error("The local test channel is not running or did not respond.");
    error.statusCode = 502;
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  return { status: response.status, result };
}

async function connectionStatus(propertyId) {
  const config = configuration(propertyId);
  if (!config.available) return { provider: PROVIDER, mode: "test-only", state: "unavailable", message: config.reason };
  try {
    const { status, result } = await requestChannel(config, propertyId, "GET");
    if (status === 200 && result.property_id === propertyId) {
      return {
        provider: PROVIDER, mode: "test-only", state: "connected",
        last_sync: result.generated_at,
        room_count: result.rooms?.length || 0,
        rate_count: result.rates?.length || 0,
        rooms: Array.isArray(result.rooms) ? result.rooms : [],
        rates: Array.isArray(result.rates) ? result.rates : [],
        message: "Authenticated local test channel; room and rate snapshot is present. No real OTA is connected."
      };
    }
    if (status === 404 && result.message === "Push a PMS snapshot first.") {
      return { provider: PROVIDER, mode: "test-only", state: "ready_to_sync", message: "Authenticated local test channel. Sync rooms and rates to finish setup." };
    }
    return { provider: PROVIDER, mode: "test-only", state: "error", message: status === 401 ? "Test channel API keys do not match." : (result.message || `Test channel returned ${status}.`) };
  } catch (error) {
    return { provider: PROVIDER, mode: "test-only", state: "offline", message: error.message };
  }
}

function isoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
}

function buildSnapshot(propertyId, roomTypes, ratePlans) {
  const rooms = roomTypes.map((room) => ({
    channel_room_id: `TEST-ROOM-${room._id}`,
    pms_room_type_id: String(room._id),
    name: room.name,
    physical_room_count: (room.physical_rooms || []).filter((physical) =>
      physical.active && !["out_of_order", "maintenance"].includes(physical.operational_status)
    ).length
  }));
  const roomIds = new Set(rooms.map((room) => room.pms_room_type_id));
  const rates = ratePlans.map((plan) => ({
    channel_rate_id: `TEST-RATE-${plan._id}`,
    pms_rate_plan_id: String(plan._id),
    name: plan.name,
    code: plan.code,
    meal_plan: plan.meal_plan,
    currency: plan.currency,
    valid_from: isoDate(plan.valid_from),
    valid_to: isoDate(plan.valid_to),
    room_type_rates: (plan.room_type_rates || []).filter((rate) => roomIds.has(String(rate.room_type_id))).map((rate) => ({
      channel_room_id: `TEST-ROOM-${rate.room_type_id}`,
      amount: Number(rate.amount)
    }))
  }));
  return {
    property_id: propertyId,
    generated_at: new Date().toISOString(),
    warning: "Test snapshot only. Physical room count is not date-specific availability. No real OTA receives this data.",
    rooms,
    rates
  };
}

async function syncSnapshot(propertyId) {
  const config = configuration(propertyId);
  if (!config.available) {
    const error = new Error(config.reason);
    error.statusCode = 409;
    throw error;
  }
  const [rooms, rates] = await Promise.all([
    RoomType.find({ property_id: propertyId, active: true }).lean(),
    RatePlan.find({ property_id: propertyId, active: true }).lean()
  ]);
  const snapshot = buildSnapshot(propertyId, rooms, rates);
  if (!snapshot.rooms.length || !snapshot.rates.some((rate) => rate.room_type_rates.length)) {
    const error = new Error("Create an active room type and an active mapped rate plan before syncing.");
    error.statusCode = 409;
    throw error;
  }
  const { status, result } = await requestChannel(config, propertyId, "PUT", snapshot);
  if (status !== 200) {
    const error = new Error(status === 401 ? "Test channel API keys do not match." : (result.message || `Test channel returned ${status}.`));
    error.statusCode = 502;
    throw error;
  }
  return { ...snapshot, state: "connected" };
}

async function listImportedBookings(propertyId) {
  return Reservation.find({
    property_id: propertyId,
    "external_channel.provider": PROVIDER,
    deleted_at: { $exists: false }
  }).sort({ reservation_date: -1, _id: -1 }).limit(100).lean();
}

module.exports = { PROVIDER, configuration, connectionStatus, buildSnapshot, syncSnapshot, listImportedBookings };
