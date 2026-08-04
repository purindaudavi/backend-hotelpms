const Reservation = require("../db_models/booking.model");
const RoomType = require("../db_models/rooms.model");

const OCCUPANCY_STATUSES = new Set(["confirmed", "checked_in", "checked_out"]);
const ARRIVAL_STATUSES = new Set(["tentative", "confirmed", "checked_in"]);
const DEPARTURE_STATUSES = new Set(["confirmed", "checked_in", "checked_out"]);

async function getDashboardSummary({ propertyId, asOf, currency = "" }) {
  const date = dateOnly(asOf || new Date(), "as_of");
  const [reservations, roomTypes] = await Promise.all([
    Reservation.find({ property_id: propertyId, deleted_at: { $exists: false } }).lean(),
    RoomType.find({ property_id: propertyId, active: true }).lean()
  ]);

  return buildDashboardSummary({
    propertyId,
    asOf: date,
    currency: normalizeCurrency(currency) || inferCurrency(reservations, roomTypes),
    reservations,
    roomTypes
  });
}

function buildDashboardSummary({ propertyId = "", asOf, currency = "LKR", reservations = [], roomTypes = [] }) {
  const date = dateOnly(asOf || new Date(), "as_of");
  const selectedCurrency = normalizeCurrency(currency) || "LKR";
  const todayStart = date;
  const tomorrow = addDays(date, 1);
  const monthStart = startOfMonth(date);
  const nextMonthStart = addMonths(monthStart, 1);
  const activeRooms = roomTypes.flatMap((roomType) =>
    (roomType.physical_rooms || []).filter((room) => room.active !== false)
  );
  const sellableRooms = activeRooms.filter((room) =>
    !["out_of_order", "maintenance"].includes(room.operational_status)
  );
  const occupiedRooms = activeRooms.filter((room) => room.operational_status === "occupied").length;
  const arrivals = reservations.filter((reservation) =>
    ARRIVAL_STATUSES.has(reservation.status) && sameDay(reservation.check_in, date)
  );
  const departures = reservations.filter((reservation) =>
    DEPARTURE_STATUSES.has(reservation.status) && sameDay(reservation.check_out, date)
  );
  const currentMonthReservations = reservations.filter((reservation) =>
    overlaps(reservation, monthStart, nextMonthStart)
  );
  const revenueReservations = reservations.filter((reservation) =>
    OCCUPANCY_STATUSES.has(reservation.status) &&
    reservation.currency === selectedCurrency &&
    inRange(reservation.check_in, monthStart, nextMonthStart)
  );

  const occupancyTrend = eachDay(addDays(date, -6), date).map((day) => {
    const occupied = occupiedRoomCount(reservations, day);
    return {
      date: isoDate(day),
      occupied_rooms: occupied,
      total_rooms: sellableRooms.length,
      occupancy: percentage(occupied, sellableRooms.length)
    };
  });

  const monthlyOccupancy = [monthStart, nextMonthStart].map((start) => {
    const end = addMonths(start, 1);
    const bookedNights = roomNightsForRange(reservations, start, end, OCCUPANCY_STATUSES);
    const capacity = sellableRooms.length * daysBetween(start, end);
    return {
      month: isoDate(start).slice(0, 7),
      occupied_room_nights: bookedNights,
      available_room_nights: capacity,
      occupancy: percentage(bookedNights, capacity)
    };
  });

  const bookingSources = groupedRoomNights(
    currentMonthReservations.filter((reservation) => OCCUPANCY_STATUSES.has(reservation.status)),
    (reservation) => reservation.booking_source || "Unknown",
    monthStart,
    nextMonthStart
  );
  const countries = groupedRoomNights(
    currentMonthReservations.filter((reservation) => OCCUPANCY_STATUSES.has(reservation.status)),
    (reservation) => reservation.booker?.country || "Unknown",
    monthStart,
    nextMonthStart
  );
  const monthlyRoomNights = monthSeries(date, 6).map((start) => {
    const end = addMonths(start, 1);
    const matching = reservations.filter((reservation) => overlaps(reservation, start, end));
    return {
      month: isoDate(start).slice(0, 7),
      room_nights: roomNightsForRange(matching, start, end, OCCUPANCY_STATUSES),
      cancelled: matching.filter((reservation) => reservation.status === "cancelled").length,
      no_show: matching.filter((reservation) => reservation.status === "no_show").length
    };
  });
  const monthlyPerformance = monthSeries(date, 12).map((start) => {
    const end = addMonths(start, 1);
    const matching = reservations.filter((reservation) =>
      OCCUPANCY_STATUSES.has(reservation.status) && overlaps(reservation, start, end)
    );
    const roomNights = roomNightsForRange(matching, start, end, OCCUPANCY_STATUSES);
    const revenue = round(matching
      .filter((reservation) => reservation.currency === selectedCurrency && inRange(reservation.check_in, start, end))
      .reduce((total, reservation) => total + number(reservation.financial_summary?.grand_total), 0));
    const capacity = sellableRooms.length * daysBetween(start, end);
    return {
      month: isoDate(start).slice(0, 7),
      revenue,
      room_nights: roomNights,
      occupancy: percentage(roomNights, capacity),
      adr: round(roomNights ? revenue / roomNights : 0),
      revpar: round(capacity ? revenue / capacity : 0)
    };
  });

  const financialTotals = revenueReservations.reduce((totals, reservation) => {
    totals.room_revenue += number(reservation.financial_summary?.room_total);
    totals.tax += number(reservation.financial_summary?.tax_total);
    totals.extras += number(reservation.financial_summary?.extra_total);
    totals.discounts += number(reservation.financial_summary?.discount_total);
    return totals;
  }, { room_revenue: 0, tax: 0, extras: 0, discounts: 0 });

  const demographics = groupCounts(currentMonthReservations, (reservation) => {
    if (reservation.business_block_id || reservation.group_name) return "Group";
    if (reservation.travel_agent?.name) return "Travel Agent";
    return reservation.booking_source || "Direct";
  });
  const agentReservations = currentMonthReservations.filter((reservation) => reservation.travel_agent?.name);
  const agents = Array.from(groupBy(agentReservations, (reservation) => reservation.travel_agent.name).entries())
    .map(([label, items]) => ({
      label,
      room_nights: roomNightsForRange(items, monthStart, nextMonthStart, OCCUPANCY_STATUSES),
      cancelled: items.filter((item) => item.status === "cancelled").length,
      no_show: items.filter((item) => item.status === "no_show").length,
      new_bookings: items.length
    }))
    .sort((left, right) => right.room_nights - left.room_nights || left.label.localeCompare(right.label));
  const mealPlans = groupedRoomNights(
    currentMonthReservations.filter((reservation) => OCCUPANCY_STATUSES.has(reservation.status)),
    (reservation) => reservation.meal_plan || "No meal plan",
    monthStart,
    nextMonthStart
  );

  return {
    property_id: propertyId,
    as_of: isoDate(date),
    period: { date_from: isoDate(monthStart), date_to: isoDate(addDays(nextMonthStart, -1)) },
    currency: selectedCurrency,
    generated_at: new Date().toISOString(),
    overview: {
      arrivals: arrivals.length,
      arrival_guests: guestCount(arrivals),
      departures: departures.length,
      departure_rooms: roomCount(departures),
      occupied_rooms: occupiedRooms,
      total_rooms: activeRooms.length,
      sellable_rooms: sellableRooms.length,
      occupancy: percentage(occupiedRooms, sellableRooms.length),
      revenue: round(revenueReservations.reduce(
        (total, reservation) => total + number(reservation.financial_summary?.grand_total), 0
      )),
      revenue_label: "Current month reservation revenue"
    },
    occupancy_trend: occupancyTrend,
    monthly_occupancy: monthlyOccupancy,
    booking_sources: bookingSources,
    monthly_room_nights: monthlyRoomNights,
    countries,
    analytics: {
      monthly_performance: monthlyPerformance,
      revenue_breakdown: Object.entries(financialTotals).map(([label, value]) => ({ label, value: round(value) })),
      guest_demographics: demographics
    },
    travel_agents: {
      summary: {
        room_nights: agents.reduce((total, item) => total + item.room_nights, 0),
        cancelled: agents.reduce((total, item) => total + item.cancelled, 0),
        no_show: agents.reduce((total, item) => total + item.no_show, 0),
        new_bookings: agents.reduce((total, item) => total + item.new_bookings, 0)
      },
      agents,
      meal_plans: mealPlans
    }
  };
}

function groupedRoomNights(reservations, labelFor, start, end) {
  const grouped = new Map();
  for (const reservation of reservations) {
    const label = String(labelFor(reservation) || "Unknown").trim() || "Unknown";
    grouped.set(label, (grouped.get(label) || 0) + reservationRoomNights(reservation, start, end));
  }
  return Array.from(grouped.entries())
    .map(([label, room_nights]) => ({ label, room_nights }))
    .filter((item) => item.room_nights > 0)
    .sort((left, right) => right.room_nights - left.room_nights || left.label.localeCompare(right.label));
}

function groupCounts(reservations, labelFor) {
  const groups = groupBy(reservations, labelFor);
  return Array.from(groups.entries())
    .map(([label, items]) => ({ label, value: items.length }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
}

function groupBy(items, labelFor) {
  const grouped = new Map();
  for (const item of items) {
    const label = String(labelFor(item) || "Unknown").trim() || "Unknown";
    grouped.set(label, [...(grouped.get(label) || []), item]);
  }
  return grouped;
}

function roomNightsForRange(reservations, start, end, statuses) {
  return reservations.reduce((total, reservation) => {
    if (!statuses.has(reservation.status)) return total;
    return total + reservationRoomNights(reservation, start, end);
  }, 0);
}

function reservationRoomNights(reservation, start, end) {
  const checkIn = dateOnly(reservation.check_in, "check_in");
  const checkOut = dateOnly(reservation.check_out, "check_out");
  const rangeStart = checkIn > start ? checkIn : start;
  const effectiveCheckOut = reservation.is_day_room ? addDays(checkIn, 1) : checkOut;
  const rangeEnd = effectiveCheckOut < end ? effectiveCheckOut : end;
  if (rangeEnd <= rangeStart) return 0;
  return roomCount([reservation]) * daysBetween(rangeStart, rangeEnd);
}

function occupiedRoomCount(reservations, day) {
  const next = addDays(day, 1);
  const ids = new Set();
  let unassigned = 0;
  for (const reservation of reservations) {
    if (!OCCUPANCY_STATUSES.has(reservation.status) || !overlaps(reservation, day, next)) continue;
    for (const room of reservation.rooms || []) {
      const id = room.physical_room_id ? String(room.physical_room_id) : "";
      if (id) ids.add(id);
      else unassigned += 1;
    }
  }
  return ids.size + unassigned;
}

function overlaps(reservation, start, end) {
  const checkIn = dateOnly(reservation.check_in, "check_in");
  const checkOut = reservation.is_day_room ? addDays(checkIn, 1) : dateOnly(reservation.check_out, "check_out");
  return checkIn < end && checkOut > start;
}

function inRange(value, start, end) {
  const date = dateOnly(value, "date");
  return date >= start && date < end;
}

function guestCount(reservations) {
  return reservations.reduce((total, reservation) => total + (reservation.rooms || [])
    .reduce((count, room) => count + number(room.adults) + number(room.children), 0), 0);
}

function roomCount(reservations) {
  return reservations.reduce((total, reservation) => total + (reservation.rooms || []).length, 0);
}

function inferCurrency(reservations, roomTypes) {
  const values = [
    ...reservations.map((reservation) => reservation.currency),
    ...roomTypes.map((roomType) => roomType.currency)
  ].map(normalizeCurrency).filter(Boolean);
  if (!values.length) return "LKR";
  const counts = values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map());
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0][0];
}

function normalizeCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw httpError(400, "currency must be a three-letter code such as LKR or USD.");
  return currency;
}

function monthSeries(date, count) {
  const current = startOfMonth(date);
  return Array.from({ length: count }, (_, index) => addMonths(current, index - count + 1));
}

function eachDay(start, end) {
  const days = [];
  for (let current = start; current <= end; current = addDays(current, 1)) days.push(current);
  return days;
}

function startOfMonth(value) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addMonths(value, amount) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + amount, 1));
}

function addDays(value, amount) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function daysBetween(start, end) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

function sameDay(value, date) {
  return isoDate(value) === isoDate(date);
}

function dateOnly(value, field) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(400, `${field} must use YYYY-MM-DD format.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== text) throw httpError(400, `${field} is not a valid calendar date.`);
  return date;
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function percentage(value, total) {
  return total > 0 ? round(Math.min(100, Math.max(0, (value / total) * 100))) : 0;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  buildDashboardSummary,
  getDashboardSummary
};
