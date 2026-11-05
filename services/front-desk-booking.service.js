const { quoteRatePlan } = require("./rate-quote.service");
const TravelAgent = require("../db_models/travel-agents.model");

const PRICING_CONTEXT = ["room_type_id", "adults", "children", "rate_plan_id", "currency", "meal_plan"];
const PRICE_FIELDS = ["original_nightly_rate", "effective_nightly_rate", "is_complimentary", "complimentary_reason", "requires_manager_approval"];
const key = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "");
const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
function denied(message) { return Object.assign(new Error(message), { statusCode: 403, code: "PROPERTY_PERMISSION_DENIED" }); }

async function enforceFrontDeskBookingRules({ role, reservation, previous = null, session, quote = quoteRatePlan }) {
  if (role !== "front_desk") return;
  const oldRooms = previous?.rooms || [];
  let repriced = !previous || oldRooms.length !== reservation.rooms.length;
  for (const room of reservation.rooms) {
    const old = oldRooms.find((item) => key(item._id) === key(room._id));
    const sameStay = previous && ["check_in", "check_out", "is_day_room", "rate_plan_id", "currency", "meal_plan"]
      .every((field) => key(reservation[field]) === key(previous[field]));
    const sameContext = old && sameStay && PRICING_CONTEXT.every((field) => key(room[field]) === key(old[field]));
    if (sameContext) {
      if (PRICE_FIELDS.some((field) => key(room[field]) !== key(old[field]))) {
        throw denied("Front Desk cannot change saved prices or complimentary approvals. Ask an owner or administrator.");
      }
      room.rate_plan_name = old.rate_plan_name;
      room.room_type_name = old.room_type_name;
      continue;
    }
    repriced = true;
    if (room.is_complimentary || room.requires_manager_approval || room.complimentary_reason || old?.is_complimentary ||
        (old && Number(old.original_nightly_rate) !== Number(old.effective_nightly_rate))) {
      throw denied("An owner or administrator must change a stay with complimentary rooms or approved price overrides.");
    }
    const rate = await quote({ propertyId: reservation.property_id, ratePlanId: reservation.rate_plan_id,
      roomTypeId: room.room_type_id, checkIn: key(reservation.check_in), checkOut: key(reservation.check_out),
      adults: room.adults, children: room.children, dayRoom: Boolean(reservation.is_day_room), session });
    if (Math.abs(Number(room.effective_nightly_rate) - rate.average_nightly_rate) > 0.01 ||
        Math.abs(Number(room.original_nightly_rate) - rate.average_nightly_rate) > 0.01) {
      throw denied("Front Desk cannot override room prices. Refresh the rate quote or ask an owner or administrator.");
    }
    reservation.currency = rate.currency;
    reservation.rate_plan_name = rate.rate_plan_name;
    reservation.meal_plan = rate.meal_plan;
    reservation.refundable = rate.refundable;
    reservation.cancellation_policy = rate.cancellation_policy;
    room.rate_plan_id = key(reservation.rate_plan_id);
    room.rate_plan_name = rate.rate_plan_name;
    if (rate.room_type_name) room.room_type_name = rate.room_type_name;
    room.currency = rate.currency;
    room.meal_plan = rate.meal_plan;
    room.original_nightly_rate = rate.average_nightly_rate;
    room.effective_nightly_rate = rate.average_nightly_rate;
  }
  if (previous && !repriced) {
    // Contact/room-assignment edits keep historical amounts and terms intact.
    reservation.financial_summary = previous.financial_summary;
    reservation.refundable = previous.refundable;
    reservation.cancellation_policy = previous.cancellation_policy;
    reservation.rate_plan_name = previous.rate_plan_name;
  } else {
    const nights = reservation.is_day_room ? 1 : (new Date(reservation.check_out) - new Date(reservation.check_in)) / 86400000;
    const total = money(reservation.rooms.reduce((sum, room) => sum + Number(room.effective_nightly_rate) * nights, 0));
    const prior = previous?.financial_summary || {};
    const tax = Number(prior.tax_total || 0), discount = Number(prior.discount_total || 0), extra = Number(prior.extra_total || 0);
    reservation.financial_summary = { room_total: total, tax_total: tax, discount_total: discount, extra_total: extra,
      grand_total: money(total + tax - discount + extra), paid_total: Number(prior.paid_total || 0) };
  }
  const agentId = key(reservation.travel_agent?.travel_agent_id);
  if (agentId && agentId === key(previous?.travel_agent?.travel_agent_id)) reservation.travel_agent = previous.travel_agent;
  else if (agentId) {
    const agentQuery = TravelAgent.findOne({ _id: agentId, property_id: reservation.property_id, status: "active" });
    const agent = await (session ? agentQuery.session(session) : agentQuery);
    if (!agent) throw denied("Select an active travel agent for this property.");
    reservation.travel_agent = { travel_agent_id: agent._id, name: agent.name, commission_percentage: agent.commission_percentage };
  } else reservation.travel_agent = { travel_agent_id: "", name: "", commission_percentage: 0 };
}

function enforceFrontDeskPaymentCurrency(role, requestedCurrency, reservationCurrency) {
  if (role === "front_desk" && requestedCurrency && String(requestedCurrency).trim().toUpperCase() !== reservationCurrency) {
    throw Object.assign(new Error("Record this payment in the reservation's currency."), { statusCode: 400 });
  }
}

module.exports = { enforceFrontDeskBookingRules, enforceFrontDeskPaymentCurrency };
