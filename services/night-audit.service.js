const FinancialTransaction = require("../db_models/financial-transaction.model");
const Reservation = require("../db_models/booking.model");
const RoomType = require("../db_models/rooms.model");

const ACTIVE_RESERVATION_STATUSES = ["tentative", "confirmed", "checked_in"];

async function buildNightAuditSnapshot({ property, audit, session = null }) {
  const start = dateOnly(audit.business_date, "business_date");
  const end = addDays(start, 1);
  const propertyId = audit.property_id;

  const [reservations, roomTypes, transactions] = await Promise.all([
    Reservation.find({
      property_id: propertyId,
      deleted_at: { $exists: false },
      status: { $in: ACTIVE_RESERVATION_STATUSES }
    }).session(session),
    RoomType.find({ property_id: propertyId, active: true }).session(session),
    FinancialTransaction.find({
      property_id: propertyId,
      transaction_date: { $gte: start, $lt: end },
      status: "posted"
    }).session(session)
  ]);

  const dueArrivals = reservations.filter((record) =>
    sameDate(record.check_in, start) && ["tentative", "confirmed"].includes(record.status)
  );
  const overdueArrivals = reservations.filter((record) =>
    record.check_in < start && ["tentative", "confirmed"].includes(record.status)
  );
  const dueDepartures = reservations.filter((record) =>
    record.status === "checked_in" && record.check_out <= start
  );
  const inHouse = reservations.filter((record) =>
    record.status === "checked_in" && record.check_in <= start && record.check_out > start
  );

  const rooms = roomTypes.flatMap((roomType) =>
    roomType.physical_rooms
      .filter((room) => room.active !== false)
      .map((room) => ({
        id: String(room._id),
        room_number: room.room_number,
        room_type: roomType.name,
        operational_status: room.operational_status,
        housekeeping_status: room.housekeeping_status
      }))
  );
  const dirtyRooms = rooms.filter((room) => ["dirty", "in_progress"].includes(room.housekeeping_status));
  const outOfOrderRooms = rooms.filter((room) => ["out_of_order", "maintenance"].includes(room.operational_status));
  const openBalances = reservations
    .map((record) => ({
      reservation_id: String(record._id),
      reservation_no: record.reservation_no,
      guest_name: record.booker?.name || "",
      currency: record.currency,
      balance: money(Number(record.financial_summary?.grand_total || 0) - Number(record.financial_summary?.paid_total || 0))
    }))
    .filter((record) => record.balance > 0);

  const revenueAlreadyPosted = Boolean(audit.revenue_posted_at);
  const estimatedRoomRevenue = revenueAlreadyPosted
    ? Number(audit.revenue_posted_amount || 0)
    : money(inHouse.reduce((sum, reservation) => sum + nightlyRoomRevenue(reservation), 0));
  const depositTotal = money(reservations.reduce(
    (sum, record) => sum + Number(record.financial_summary?.paid_total || 0),
    0
  ));
  const openBalanceTotal = money(openBalances.reduce((sum, record) => sum + record.balance, 0));

  return {
    business_date: dateKey(start),
    currency: audit.currency,
    occupied_rooms: rooms.filter((room) => room.operational_status === "occupied").length,
    available_rooms: rooms.filter((room) => room.operational_status === "available").length,
    total_active_rooms: rooms.length,
    due_arrivals: dueArrivals.map(reservationReference),
    overdue_arrivals: overdueArrivals.map(reservationReference),
    due_departures: dueDepartures.map(reservationReference),
    in_house: inHouse.map(reservationReference),
    estimated_room_revenue: estimatedRoomRevenue,
    revenue_posted: revenueAlreadyPosted,
    revenue_posted_amount: Number(audit.revenue_posted_amount || 0),
    revenue_transaction_id: audit.revenue_transaction_id ? String(audit.revenue_transaction_id) : "",
    transaction_count: transactions.length,
    transaction_total: money(transactions.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
    deposit_total: depositTotal,
    open_balance_total: openBalanceTotal,
    open_balances: openBalances,
    dirty_rooms: dirtyRooms,
    out_of_order_rooms: outOfOrderRooms,
    channel_manager: {
      connected: false,
      requested_active: Boolean(property.info?.cm_active),
      configured_property_id: property.info?.cm_property_id || ""
    }
  };
}

function buildNightAuditSteps(audit, snapshot) {
  const steps = [
    step({
      id: "front-desk-status",
      title: "Front Desk Status",
      description: "Review arrivals, departures, in-house guests, no-shows, and checkout readiness.",
      metric: `${snapshot.in_house.length} in-house`,
      exceptions: [
        ...snapshot.overdue_arrivals.map((reservation) => exception(
          `arrival-overdue:${reservation.reservation_id}`,
          `${reservation.reservation_no} overdue arrival`,
          `${reservation.guest_name} was due on ${reservation.check_in} and has not been checked in or marked no-show.`,
          "blocker"
        )),
        ...snapshot.due_departures.map((reservation) => exception(
          `departure:${reservation.reservation_id}`,
          `${reservation.reservation_no} due departure`,
          `${reservation.guest_name} is still checked in after the scheduled checkout date.`,
          "blocker"
        )),
        ...snapshot.due_arrivals.map((reservation) => exception(
          `arrival-today:${reservation.reservation_id}`,
          `${reservation.reservation_no} arrival due`,
          `${reservation.guest_name} is expected on this business date.`,
          "warning"
        ))
      ]
    }),
    step({
      id: "folio-posting",
      title: "Post Pending Folio Charges",
      description: "Post the occupied-room revenue batch for the business date.",
      metric: moneyLabel(snapshot.currency, snapshot.revenue_posted ? snapshot.revenue_posted_amount : snapshot.estimated_room_revenue),
      exceptions: snapshot.estimated_room_revenue > 0 && !snapshot.revenue_posted
        ? [exception(
            "folio:room-revenue",
            "Room revenue not posted",
            `${moneyLabel(snapshot.currency, snapshot.estimated_room_revenue)} is ready to post.`,
            "blocker"
          )]
        : []
    }),
    step({
      id: "payment-reconciliation",
      title: "Reconcile Payments",
      description: "Review deposits, recorded payments, and outstanding balances.",
      metric: moneyLabel(snapshot.currency, snapshot.deposit_total),
      exceptions: snapshot.open_balances.map((record) => exception(
        `balance:${record.reservation_id}`,
        `${record.reservation_no} open balance`,
        `${record.guest_name} has ${moneyLabel(record.currency || snapshot.currency, record.balance)} outstanding.`,
        "warning"
      ))
    }),
    step({
      id: "housekeeping-close",
      title: "Review Housekeeping Board",
      description: "Confirm room cleanliness and maintenance status for the next operating day.",
      metric: `${snapshot.dirty_rooms.length} open`,
      exceptions: [
        ...snapshot.dirty_rooms.map((room) => exception(
          `housekeeping:${room.id}`,
          `Room ${room.room_number} ${readable(room.housekeeping_status)}`,
          `${room.room_type} must be completed in Housekeeping before close.`,
          "blocker"
        )),
        ...snapshot.out_of_order_rooms.map((room) => exception(
          `room-status:${room.id}`,
          `Room ${room.room_number} ${readable(room.operational_status)}`,
          `${room.room_type} requires an acknowledged operational exception.`,
          "warning"
        ))
      ]
    }),
    step({
      id: "channel-check",
      title: "Channel Manager Check",
      description: snapshot.channel_manager.connected
        ? "Review channel acknowledgements and inventory synchronization."
        : "Channel Manager is not connected, so this check is not required.",
      metric: snapshot.channel_manager.connected ? "Pending reconciliation" : "Not connected",
      required: snapshot.channel_manager.connected,
      disabled: !snapshot.channel_manager.connected,
      exceptions: snapshot.channel_manager.connected
        ? [exception(
            "channel:integration",
            "Live Channel Manager is not connected",
            "Disable cm_active or complete the external channel integration before making this check required.",
            "blocker"
          )]
        : []
    }),
    step({
      id: "audit-reports",
      title: "Generate Audit Reports",
      description: "Generate and store the close pack before finalizing the business date.",
      metric: audit.reports_generated_at ? "Ready" : "Pending",
      exceptions: audit.reports_generated_at
        ? []
        : [exception(
            "reports:pack",
            "Night audit pack not generated",
            "Generate the required close reports before completing the audit.",
            "blocker"
          )]
    })
  ];

  return steps.map((item) => finalizeStep(item, audit));
}

function nightAuditCanComplete(steps) {
  return steps
    .filter((item) => item.required)
    .every((item) => ["done", "reviewed_with_warnings"].includes(item.status));
}

function unresolvedBlockers(steps) {
  return steps.flatMap((item) =>
    item.exceptions
      .filter((entry) => entry.severity === "blocker" && !entry.resolved)
      .map((entry) => ({ ...entry, step_id: item.id }))
  );
}

function serializeNightAudit(audit, snapshot, steps) {
  return {
    _id: String(audit._id),
    property_id: audit.property_id,
    business_date: dateKey(audit.business_date),
    status: audit.status,
    currency: audit.currency,
    reviewed_step_ids: audit.reviewed_step_ids,
    overrides: audit.overrides.map((item) => ({
      _id: String(item._id),
      step_id: item.step_id,
      exception_id: item.exception_id,
      reason: item.reason,
      approved_by: item.approved_by,
      approved_at: item.approved_at
    })),
    revenue_posted_at: audit.revenue_posted_at,
    revenue_posted_amount: audit.revenue_posted_amount,
    revenue_transaction_id: audit.revenue_transaction_id ? String(audit.revenue_transaction_id) : "",
    reports_generated_at: audit.reports_generated_at,
    reports: audit.reports,
    close_note: audit.close_note,
    close_summary: audit.close_summary,
    closed_at: audit.closed_at,
    closed_by: audit.closed_by,
    next_business_date: audit.next_business_date ? dateKey(audit.next_business_date) : "",
    snapshot,
    steps,
    can_complete: nightAuditCanComplete(steps),
    blockers: unresolvedBlockers(steps)
  };
}

function finalizeStep(item, audit) {
  const reviewed = audit.reviewed_step_ids.includes(item.id);
  const overridden = new Set(audit.overrides.map((entry) => entry.exception_id));
  const exceptions = item.exceptions.map((entry) => ({ ...entry, resolved: overridden.has(entry.id) }));
  const blockers = exceptions.filter((entry) => entry.severity === "blocker" && !entry.resolved);
  const warnings = exceptions.filter((entry) => entry.severity === "warning" && !entry.resolved);
  let status = "ready";
  if (item.disabled) status = "disabled";
  else if (blockers.length) status = "blocked";
  else if (reviewed && warnings.length) status = "reviewed_with_warnings";
  else if (reviewed) status = "done";
  else if (warnings.length) status = "warning";
  return { ...item, exceptions, status };
}

function step({ id, title, description, metric, required = true, disabled = false, exceptions = [] }) {
  return { id, title, description, metric, required, disabled, exceptions };
}

function exception(id, label, detail, severity) {
  return { id, label, detail, severity };
}

function reservationReference(record) {
  return {
    reservation_id: String(record._id),
    reservation_no: record.reservation_no,
    guest_name: record.booker?.name || "",
    status: record.status,
    check_in: dateKey(record.check_in),
    check_out: dateKey(record.check_out)
  };
}

function nightlyRoomRevenue(reservation) {
  const roomRates = (reservation.rooms || []).map((room) => Number(room.effective_nightly_rate || 0));
  const configuredTotal = roomRates.reduce((sum, value) => sum + value, 0);
  if (configuredTotal > 0) return configuredTotal;
  const nights = Math.max(1, Math.round((reservation.check_out - reservation.check_in) / 86_400_000));
  return Number(reservation.financial_summary?.grand_total || 0) / nights;
}

function dateOnly(value, field = "date") {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(400, `${field} must use YYYY-MM-DD format.`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw httpError(400, `${field} must be a valid calendar date.`);
  }
  return parsed;
}

function addDays(value, days) {
  const date = dateOnly(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function dateKey(value) {
  return dateOnly(value).toISOString().slice(0, 10);
}

function sameDate(left, right) {
  return dateKey(left) === dateKey(right);
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function moneyLabel(currency, value) {
  return `${currency} ${money(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function readable(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function httpError(statusCode, message, code = "NIGHT_AUDIT_REQUEST_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  addDays,
  buildNightAuditSnapshot,
  buildNightAuditSteps,
  dateKey,
  dateOnly,
  httpError,
  nightAuditCanComplete,
  serializeNightAudit,
  unresolvedBlockers
};
