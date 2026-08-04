const Reservation = require("../db_models/booking.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const BusinessBlock = require("../db_models/business-block.model");
const RoomType = require("../db_models/rooms.model");

const REPORT_CATALOG = [
  available("collection-report", "Collection Report", "Collection"),
  available("deposit-ledger", "Deposit Ledger", "Collection"),
  unavailable("trial-balance", "Trial Balance", "Finance", ["general_ledger", "chart_of_accounts"]),
  unavailable("profit-loss", "Profit & Loss", "Finance", ["general_ledger", "expenses", "purchases"]),
  available("revenue-report", "Revenue Report", "Revenue"),
  available("revenue-forecast", "Revenue Forecast - Room Revenue", "Revenue"),
  unavailable("invoice-daybook", "Invoice Daybook", "Revenue", ["invoices", "folios"]),
  available("customer-balance-summary", "Customer Balance Summary", "Receivable"),
  available("ar-aging-summary", "AR Aging Summary", "Receivable"),
  available("in-house-guest-ledger", "In-House Guest Ledger", "Receivable"),
  available("information-sheet", "Information Sheet", "Reservation"),
  available("reservation-list", "List of Reservations", "Reservation"),
  available("business-analysis", "Business Analysis", "Business"),
  available("arrival-list", "Arrival List", "Business"),
  available("travel-agent-performance", "Travel Agent Performance", "Business"),
  available("inventory-by-room-type", "Inventory By Room Type", "Occupancy"),
  available("occupancy-by-date", "Occupancy by Date", "Occupancy")
];

const builders = {
  "collection-report": collectionReport,
  "deposit-ledger": depositLedger,
  "revenue-report": revenueReport,
  "revenue-forecast": revenueForecast,
  "customer-balance-summary": customerBalanceSummary,
  "ar-aging-summary": arAgingSummary,
  "in-house-guest-ledger": inHouseGuestLedger,
  "information-sheet": informationSheet,
  "reservation-list": reservationList,
  "business-analysis": businessAnalysis,
  "arrival-list": arrivalList,
  "travel-agent-performance": travelAgentPerformance,
  "inventory-by-room-type": inventoryByRoomType,
  "occupancy-by-date": occupancyByDate
};

async function generateReport({ propertyId, reportType, parameters }) {
  const catalogItem = REPORT_CATALOG.find((item) => item.report_type === reportType);
  if (!catalogItem) throw httpError(404, "Unknown report_type.", "REPORT_TYPE_NOT_FOUND");
  if (!catalogItem.available) {
    const error = httpError(
      501,
      `${catalogItem.title} cannot be generated until its data modules are implemented.`,
      "REPORT_DATA_SOURCE_NOT_AVAILABLE"
    );
    error.requiredModules = catalogItem.required_modules;
    throw error;
  }

  const result = await builders[reportType](propertyId, parameters);
  return {
    report_type: reportType,
    title: catalogItem.title,
    group: catalogItem.group,
    property_id: propertyId,
    generated_at: new Date(),
    parameters: serializeParameters(parameters),
    columns: result.columns,
    rows: result.rows,
    summary: result.summary || {},
    totals: result.totals || {},
    limitations: result.limitations || []
  };
}

function normalizeReportParameters(input = {}) {
  const today = dateOnly(input.as_of || new Date(), "as_of");
  const defaultFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const dateFrom = input.date_from ? dateOnly(input.date_from, "date_from") : defaultFrom;
  const dateTo = input.date_to ? dateOnly(input.date_to, "date_to") : today;
  if (dateTo < dateFrom) throw httpError(400, "date_to cannot be before date_from.");
  if (daysBetween(dateFrom, dateTo) > 366) {
    throw httpError(400, "A report date range cannot exceed 366 days.");
  }

  const currency = String(input.currency || "").trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw httpError(400, "currency must be a three-letter code such as LKR or USD.");
  }

  return {
    date_from: dateFrom,
    date_to: dateTo,
    as_of: today,
    currency,
    reservation_status: String(input.reservation_status || input.status || "").trim().toLowerCase()
  };
}

async function collectionReport(propertyId, parameters) {
  const payments = await paymentRecords(propertyId, parameters);
  const reservations = await reservationsByIds(payments.map((payment) => payment.reservation_id));
  const rows = payments.map((payment) => {
    const reservation = reservations.get(String(payment.reservation_id));
    return {
      payment_id: String(payment._id),
      posted_at: isoDateTime(payment.posted_at),
      reservation_no: reservation?.reservation_no || "",
      guest_name: reservation?.booker?.name || "",
      payment_method: payment.payment_method,
      payment_reference: payment.payment_reference,
      status: payment.status,
      currency: payment.currency,
      amount: signedPaymentAmount(payment),
      cashier: payment.posted_by?.name || "System"
    };
  });
  return tabular(
    rows,
    paymentColumns(),
    { transaction_count: rows.length },
    moneyTotals(rows, "amount")
  );
}

async function depositLedger(propertyId, parameters) {
  const payments = await paymentRecords(propertyId, parameters);
  const reservations = await reservationsByIds(payments.map((payment) => payment.reservation_id));
  const grouped = new Map();
  for (const payment of payments) {
    const key = String(payment.reservation_id);
    const reservation = reservations.get(key);
    const entry = grouped.get(key) || {
      reservation_id: key,
      reservation_no: reservation?.reservation_no || "",
      guest_name: reservation?.booker?.name || "",
      check_in: isoDate(reservation?.check_in),
      check_out: isoDate(reservation?.check_out),
      currency: payment.currency,
      deposit_amount: 0,
      payment_count: 0
    };
    entry.deposit_amount += signedPaymentAmount(payment);
    entry.payment_count += 1;
    grouped.set(key, entry);
  }
  const rows = Array.from(grouped.values());
  return tabular(rows, columnsFromKeys(rows, [
    "reservation_no", "guest_name", "check_in", "check_out", "currency", "deposit_amount", "payment_count"
  ]), { reservation_count: rows.length }, moneyTotals(rows, "deposit_amount"));
}

async function reservationList(propertyId, parameters) {
  const reservations = await reservationRecords(propertyId, parameters, "reservation_date");
  const rows = reservations.map(reservationRow);
  return tabular(rows, columnsFromKeys(rows, [
    "reservation_no", "booking_reference", "reservation_date", "check_in", "check_out", "guest_name",
    "room_count", "booking_source", "travel_agent", "status", "currency", "grand_total", "paid_total", "balance"
  ]), reservationSummary(rows), reservationMoneyTotals(rows));
}

async function informationSheet(propertyId, parameters) {
  const reservations = await reservationRecords(propertyId, parameters, "reservation_date");
  const rows = reservations.map((reservation) => ({
    ...reservationRow(reservation),
    phone: reservation.booker?.phone || "",
    email: reservation.booker?.email || "",
    country: reservation.booker?.country || "",
    rooms: reservation.rooms.map((room) => `${room.room_type_name}${room.room_number ? ` (${room.room_number})` : ""}`).join(", "),
    adults: sum(reservation.rooms, "adults"),
    children: sum(reservation.rooms, "children"),
    meal_plan: reservation.meal_plan || "",
    guest_remarks: reservation.guest_remarks || ""
  }));
  return tabular(rows, columnsFromRows(rows), reservationSummary(rows), reservationMoneyTotals(rows));
}

async function arrivalList(propertyId, parameters) {
  const reservations = await reservationRecords(propertyId, parameters, "check_in", {
    status: { $in: ["tentative", "confirmed", "checked_in"] }
  });
  const rows = reservations.map((reservation) => ({
    reservation_no: reservation.reservation_no,
    arrival_date: isoDate(reservation.check_in),
    guest_name: reservation.booker.name,
    phone: reservation.booker.phone,
    room_numbers: reservation.rooms.map((room) => room.room_number).filter(Boolean).join(", "),
    room_types: reservation.rooms.map((room) => room.room_type_name).join(", "),
    room_count: reservation.rooms.length,
    adults: sum(reservation.rooms, "adults"),
    children: sum(reservation.rooms, "children"),
    status: reservation.status,
    balance: balance(reservation),
    currency: reservation.currency
  }));
  return tabular(rows, columnsFromRows(rows), { arrival_count: rows.length, room_count: sum(rows, "room_count") }, moneyTotals(rows, "balance"));
}

async function revenueReport(propertyId, parameters) {
  const reservations = await reservationRecords(propertyId, parameters, "check_in", {
    status: { $in: ["confirmed", "checked_in", "checked_out"] }
  });
  const rows = reservations.map(reservationRow);
  return tabular(
    rows,
    columnsFromKeys(rows, ["reservation_no", "check_in", "check_out", "guest_name", "status", "currency", "grand_total", "paid_total", "balance"]),
    reservationSummary(rows),
    reservationMoneyTotals(rows),
    ["Revenue is grouped by reservation check-in date and uses the saved reservation financial summary."]
  );
}

async function revenueForecast(propertyId, parameters) {
  const query = {
    status: { $in: ["tentative", "confirmed", "checked_in"] },
    check_out: { $gt: parameters.as_of }
  };
  const reservations = await reservationRecords(propertyId, parameters, "check_in", query);
  const rows = reservations.map(reservationRow);
  return tabular(
    rows,
    columnsFromKeys(rows, ["reservation_no", "check_in", "check_out", "room_count", "status", "currency", "grand_total", "paid_total", "balance"]),
    reservationSummary(rows),
    reservationMoneyTotals(rows),
    ["Forecast includes active reservations and excludes cancelled and no-show reservations."]
  );
}

async function customerBalanceSummary(propertyId, parameters) {
  const reservations = await reservationRecords(propertyId, parameters, "check_out", {
    status: { $nin: ["cancelled", "no_show"] },
    "financial_summary.grand_total": { $gt: 0 }
  });
  const rows = reservations.map(reservationRow).filter((row) => row.balance > 0);
  return tabular(rows, columnsFromKeys(rows, [
    "reservation_no", "guest_name", "check_out", "status", "currency", "grand_total", "paid_total", "balance"
  ]), { customer_count: new Set(rows.map((row) => row.guest_name)).size, reservation_count: rows.length }, moneyTotals(rows, "balance"));
}

async function arAgingSummary(propertyId, parameters) {
  const reservations = await Reservation.find({
    property_id: propertyId,
    deleted_at: { $exists: false },
    status: { $nin: ["cancelled", "no_show"] },
    "financial_summary.grand_total": { $gt: 0 },
    ...(parameters.currency ? { currency: parameters.currency } : {})
  }).sort({ check_out: 1 }).lean();
  const rows = reservations.map((reservation) => {
    const amount = balance(reservation);
    const age = Math.max(0, daysBetween(new Date(reservation.check_out), parameters.as_of));
    return {
      reservation_no: reservation.reservation_no,
      guest_name: reservation.booker.name,
      due_date: isoDate(reservation.check_out),
      days_outstanding: age,
      aging_bucket: age === 0 ? "Current" : age <= 30 ? "1-30" : age <= 60 ? "31-60" : age <= 90 ? "61-90" : "90+",
      currency: reservation.currency,
      balance: amount
    };
  }).filter((row) => row.balance > 0);
  return tabular(rows, columnsFromRows(rows), { account_count: rows.length, as_of: isoDate(parameters.as_of) }, moneyTotals(rows, "balance"));
}

async function inHouseGuestLedger(propertyId, parameters) {
  const reservations = await Reservation.find({
    property_id: propertyId,
    deleted_at: { $exists: false },
    status: "checked_in",
    ...(parameters.currency ? { currency: parameters.currency } : {})
  }).sort({ check_in: 1 }).lean();
  const rows = reservations.map(reservationRow);
  return tabular(rows, columnsFromKeys(rows, [
    "reservation_no", "guest_name", "check_in", "check_out", "room_count", "currency", "grand_total", "paid_total", "balance"
  ]), { in_house_reservations: rows.length, in_house_rooms: sum(rows, "room_count") }, reservationMoneyTotals(rows));
}

async function travelAgentPerformance(propertyId, parameters) {
  const reservations = await reservationRecords(propertyId, parameters, "check_in", {
    "travel_agent.name": { $exists: true, $ne: "" },
    status: { $nin: ["cancelled", "no_show"] }
  });
  const agents = new Map();
  for (const reservation of reservations) {
    const key = reservation.travel_agent.travel_agent_id || reservation.travel_agent.name.toLowerCase();
    const entry = agents.get(key) || {
      travel_agent_id: reservation.travel_agent.travel_agent_id || "",
      travel_agent: reservation.travel_agent.name,
      currency: reservation.currency,
      reservations: 0,
      room_nights: 0,
      revenue: 0,
      commission: 0
    };
    entry.reservations += 1;
    entry.room_nights += roomNights(reservation);
    entry.revenue += number(reservation.financial_summary?.grand_total);
    entry.commission += number(reservation.travel_agent.commission_amount);
    agents.set(key, entry);
  }
  const rows = Array.from(agents.values()).sort((a, b) => b.revenue - a.revenue);
  return tabular(rows, columnsFromRows(rows), { travel_agent_count: rows.length, reservation_count: sum(rows, "reservations") }, {
    revenue_by_currency: groupMoney(rows, "revenue"),
    commission_by_currency: groupMoney(rows, "commission"),
    total_room_nights: sum(rows, "room_nights")
  });
}

async function businessAnalysis(propertyId, parameters) {
  const blocks = await BusinessBlock.find({
    property_id: propertyId,
    deleted_at: { $exists: false },
    check_in: dateRange(parameters),
    ...(parameters.reservation_status ? { status: parameters.reservation_status } : {})
  }).sort({ check_in: 1 }).lean();
  const blockIds = blocks.map((block) => block._id);
  const picked = await Reservation.aggregate([
    { $match: { property_id: propertyId, business_block_id: { $in: blockIds }, deleted_at: { $exists: false }, status: { $nin: ["cancelled", "no_show"] } } },
    { $group: { _id: "$business_block_id", reservations: { $sum: 1 }, rooms: { $sum: { $size: "$rooms" } }, revenue: { $sum: "$financial_summary.grand_total" } } }
  ]);
  const pickedMap = new Map(picked.map((item) => [String(item._id), item]));
  const rows = blocks.map((block) => {
    const pickup = pickedMap.get(String(block._id)) || {};
    const blocked = block.allocations.reduce((total, allocation) => total + allocation.quantity, 0);
    const released = block.allocations.reduce((total, allocation) => total + number(allocation.released_quantity), 0);
    const pickedRooms = number(pickup.rooms);
    return {
      block_number: block.block_number,
      block_name: block.block_name,
      company: block.company_name,
      check_in: isoDate(block.check_in),
      check_out: isoDate(block.check_out),
      status: block.status,
      blocked,
      picked: pickedRooms,
      released,
      remaining: Math.max(0, blocked - released - pickedRooms),
      reservations: number(pickup.reservations),
      revenue: number(pickup.revenue)
    };
  });
  return tabular(rows, columnsFromRows(rows), { block_count: rows.length }, {
    blocked_rooms: sum(rows, "blocked"), picked_rooms: sum(rows, "picked"), remaining_rooms: sum(rows, "remaining")
  });
}

async function inventoryByRoomType(propertyId) {
  const roomTypes = await RoomType.find({ property_id: propertyId }).sort({ name: 1 }).lean();
  const rows = roomTypes.map((roomType) => ({
    room_type_id: String(roomType._id),
    room_type: roomType.name,
    active: roomType.active,
    total_rooms: roomType.physical_rooms.length,
    active_rooms: roomType.physical_rooms.filter((room) => room.active).length,
    available: countRooms(roomType, "operational_status", "available"),
    occupied: countRooms(roomType, "operational_status", "occupied"),
    out_of_order: countRooms(roomType, "operational_status", "out_of_order"),
    maintenance: countRooms(roomType, "operational_status", "maintenance"),
    clean: countRooms(roomType, "housekeeping_status", "clean"),
    dirty: countRooms(roomType, "housekeeping_status", "dirty"),
    in_progress: countRooms(roomType, "housekeeping_status", "in_progress")
  }));
  return tabular(rows, columnsFromRows(rows), { room_type_count: rows.length }, {
    total_rooms: sum(rows, "total_rooms"), active_rooms: sum(rows, "active_rooms"), available_rooms: sum(rows, "available")
  });
}

async function occupancyByDate(propertyId, parameters) {
  const roomTypes = await RoomType.find({ property_id: propertyId, active: true }).lean();
  const activeRooms = roomTypes.flatMap((type) => type.physical_rooms.filter((room) => room.active));
  const totalRooms = activeRooms.length;
  const reservations = await Reservation.find({
    property_id: propertyId,
    deleted_at: { $exists: false },
    status: { $in: ["tentative", "confirmed", "checked_in", "checked_out"] },
    check_in: { $lt: nextDay(parameters.date_to) },
    check_out: { $gt: parameters.date_from },
    ...(parameters.currency ? { currency: parameters.currency } : {})
  }).lean();
  const rows = eachDay(parameters.date_from, parameters.date_to).map((date) => {
    const end = nextDay(date);
    const occupiedKeys = new Set();
    let unassigned = 0;
    for (const reservation of reservations) {
      if (!(new Date(reservation.check_in) < end && new Date(reservation.check_out) > date)) continue;
      for (const room of reservation.rooms) {
        if (room.physical_room_id) occupiedKeys.add(String(room.physical_room_id));
        else unassigned += 1;
      }
    }
    const occupiedRooms = Math.min(totalRooms, occupiedKeys.size + unassigned);
    return {
      date: isoDate(date),
      total_rooms: totalRooms,
      occupied_rooms: occupiedRooms,
      available_rooms: Math.max(0, totalRooms - occupiedRooms),
      occupancy_percentage: totalRooms ? round((occupiedRooms / totalRooms) * 100) : 0
    };
  });
  return tabular(rows, columnsFromRows(rows), { days: rows.length, total_rooms: totalRooms }, {
    average_occupancy_percentage: rows.length ? round(sum(rows, "occupancy_percentage") / rows.length) : 0
  }, ["Business-block holds and cross-booking links are not deducted from the available-room figure."]);
}

async function paymentRecords(propertyId, parameters) {
  return ReservationPayment.find({
    property_id: propertyId,
    posted_at: dateRange(parameters),
    status: { $in: ["posted", "refunded"] },
    ...(parameters.currency ? { currency: parameters.currency } : {})
  }).sort({ posted_at: 1, _id: 1 }).lean();
}

async function reservationsByIds(ids) {
  const uniqueIds = Array.from(new Set(ids.map(String)));
  if (!uniqueIds.length) return new Map();
  const reservations = await Reservation.find({ _id: { $in: uniqueIds } }, {
    reservation_no: 1, booker: 1, check_in: 1, check_out: 1
  }).lean();
  return new Map(reservations.map((reservation) => [String(reservation._id), reservation]));
}

async function reservationRecords(propertyId, parameters, dateField, extra = {}) {
  return Reservation.find({
    property_id: propertyId,
    deleted_at: { $exists: false },
    [dateField]: dateRange(parameters),
    ...(parameters.currency ? { currency: parameters.currency } : {}),
    ...(parameters.reservation_status ? { status: parameters.reservation_status } : {}),
    ...extra
  }).sort({ [dateField]: 1, reservation_no: 1 }).lean();
}

function reservationRow(reservation) {
  return {
    reservation_id: String(reservation._id),
    reservation_no: reservation.reservation_no,
    booking_reference: reservation.booking_reference || "",
    reservation_date: isoDate(reservation.reservation_date),
    check_in: isoDate(reservation.check_in),
    check_out: isoDate(reservation.check_out),
    guest_name: reservation.booker?.name || "",
    room_count: reservation.rooms?.length || 0,
    booking_source: reservation.booking_source,
    travel_agent: reservation.travel_agent?.name || "",
    status: reservation.status,
    currency: reservation.currency,
    grand_total: number(reservation.financial_summary?.grand_total),
    paid_total: number(reservation.financial_summary?.paid_total),
    balance: balance(reservation)
  };
}

function normalizeColumnLabel(key) {
  return key.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function columnsFromRows(rows) {
  return columnsFromKeys(rows, rows[0] ? Object.keys(rows[0]) : []);
}

function columnsFromKeys(_rows, keys) {
  return keys.map((key) => ({ key, label: normalizeColumnLabel(key) }));
}

function paymentColumns() {
  return columnsFromKeys([], ["posted_at", "reservation_no", "guest_name", "payment_method", "payment_reference", "status", "currency", "amount", "cashier"]);
}

function tabular(rows, columns, summary = {}, totals = {}, limitations = []) {
  return { rows, columns, summary, totals, limitations };
}

function reservationSummary(rows) {
  return { reservation_count: rows.length, room_count: sum(rows, "room_count") };
}

function reservationMoneyTotals(rows) {
  return {
    grand_total_by_currency: groupMoney(rows, "grand_total"),
    paid_total_by_currency: groupMoney(rows, "paid_total"),
    balance_by_currency: groupMoney(rows, "balance")
  };
}

function moneyTotals(rows, amountField) {
  return { amount_by_currency: groupMoney(rows, amountField) };
}

function groupMoney(rows, field) {
  return rows.reduce((totals, row) => {
    const currency = row.currency || "UNKNOWN";
    totals[currency] = round(number(totals[currency]) + number(row[field]));
    return totals;
  }, {});
}

function balance(reservation) {
  return Math.max(0, number(reservation.financial_summary?.grand_total) - number(reservation.financial_summary?.paid_total));
}

function roomNights(reservation) {
  const nights = reservation.is_day_room ? 1 : Math.max(1, daysBetween(new Date(reservation.check_in), new Date(reservation.check_out)));
  return (reservation.rooms?.length || 0) * nights;
}

function countRooms(roomType, field, value) {
  return roomType.physical_rooms.filter((room) => room.active && room[field] === value).length;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + number(row[field]), 0);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function signedPaymentAmount(payment) {
  return payment.status === "refunded" ? -number(payment.amount) : number(payment.amount);
}

function dateRange(parameters) {
  return { $gte: parameters.date_from, $lt: nextDay(parameters.date_to) };
}

function nextDay(value) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function eachDay(start, end) {
  const days = [];
  for (let current = new Date(start); current <= end; current = nextDay(current)) days.push(current);
  return days;
}

function daysBetween(start, end) {
  return Math.floor((dateOnly(end, "date").getTime() - dateOnly(start, "date").getTime()) / 86_400_000);
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
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function isoDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function serializeParameters(parameters) {
  return {
    date_from: isoDate(parameters.date_from),
    date_to: isoDate(parameters.date_to),
    as_of: isoDate(parameters.as_of),
    currency: parameters.currency,
    reservation_status: parameters.reservation_status
  };
}

function reportToCsv(report) {
  const header = report.columns.map((column) => csvValue(column.label)).join(",");
  const lines = report.rows.map((row) => report.columns.map((column) => csvValue(row[column.key])).join(","));
  return `\uFEFF${[header, ...lines].join("\r\n")}`;
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function available(reportType, title, group) {
  return { report_type: reportType, title, group, available: true, required_modules: [] };
}

function unavailable(reportType, title, group, requiredModules) {
  return { report_type: reportType, title, group, available: false, required_modules: requiredModules };
}

function httpError(statusCode, message, code = "REPORT_REQUEST_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  REPORT_CATALOG,
  generateReport,
  normalizeReportParameters,
  reportToCsv
};
