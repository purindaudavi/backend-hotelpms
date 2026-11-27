const Reservation = require("../db_models/booking.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const BusinessBlock = require("../db_models/business-block.model");
const RoomType = require("../db_models/rooms.model");
const Invoice = require("../db_models/invoice.model");
const CreditNote = require("../db_models/credit-note.model");
const Refund = require("../db_models/refund.model");
const Purchase = require("../db_models/purchase.model");
const Expense = require("../db_models/expense.model");
const { reservationOverlapDateQuery } = require("./booking-inventory-dates.service");
const { inventoryUsageForDay } = require("./booking-availability.service");

const ISSUED_INVOICE_STATUSES = ["issued", "partially_paid", "paid", "credited"];

const REPORT_CATALOG = [
  available("collection-report", "Collection Report", "Collection", "Shows guest payments and completed refunds in the selected period, with the net amount collected."),
  available("deposit-ledger", "Deposit Ledger", "Collection", "Groups guest payments and refunds by reservation and currency so you can see how much was collected for each booking."),
  unavailable("trial-balance", "Trial Balance", "Finance", "Lists debit and credit balances by account to check that the books balance. This requires a general ledger and chart of accounts.", ["general_ledger", "chart_of_accounts"]),
  available("profit-loss", "Profit & Loss", "Finance", "Shows how much the property made or lost after deducting credit notes, purchases and expenses from invoiced revenue."),
  available("revenue-report", "Revenue Report", "Revenue", "Shows issued invoices and credit notes by document date, with revenue and tax listed separately."),
  available("revenue-forecast", "Revenue Forecast - Room Revenue", "Revenue", "Estimates room revenue from active bookings arriving in the selected period, using their saved room charges."),
  available("invoice-daybook", "Invoice Daybook", "Revenue", "Lists invoices by invoice date, including tax, credits, payments and the remaining balance."),
  available("customer-balance-summary", "Customer Balance Summary", "Receivable", "Shows what guests still owe on invoices from the selected period, after payments and credits."),
  available("ar-aging-summary", "AR Aging Summary", "Receivable", "Shows unpaid invoices and how many days overdue they are based on their due dates and the As Of date."),
  available("in-house-guest-ledger", "In-House Guest Ledger", "Receivable", "Shows guests currently checked in and the balances on their issued invoices."),
  available("information-sheet", "Information Sheet", "Reservation", "Lists reservation details for staff, including guest contact information, assigned rooms, meal plans and guest remarks."),
  available("reservation-list", "List of Reservations", "Reservation", "Lists reservations made in the selected period, with stay dates, booking sources, statuses and totals."),
  available("business-analysis", "Business Analysis", "Business", "Shows group room blocks, how many rooms were booked or released, and how many remain held."),
  available("arrival-list", "Arrival List", "Business", "Shows guests due to arrive in the selected dates, with room assignments and reservation status."),
  available("travel-agent-performance", "Travel Agent Performance", "Business", "Shows reservations, room nights, revenue and commission by travel agent."),
  available("inventory-by-room-type", "Inventory By Room Type", "Occupancy", "Shows current room counts by type, including rooms available, occupied, out of service or being cleaned."),
  available("occupancy-by-date", "Occupancy by Date", "Occupancy", "Shows daily occupancy and how many rooms are available after reservations, room blocks and group holds.")
];

const builders = {
  "collection-report": collectionReport,
  "deposit-ledger": depositLedger,
  "profit-loss": profitAndLoss,
  "invoice-daybook": invoiceDaybook,
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
  const movements = await collectionMovements(propertyId, parameters);
  const reservations = await reservationsByIds(propertyId, movements.map((entry) => entry.reservation_id));
  const rows = movements.map(({ reservation_id, reservation_no, ...entry }) => {
    const reservation = reservations.get(String(reservation_id));
    return {
      ...entry,
      reservation_no: reservation_no || reservation?.reservation_no || "",
      guest_name: reservation?.booker?.name || ""
    };
  });
  return tabular(
    rows,
    columnsFromKeys(rows, ["posted_at", "type", "document_no", "reservation_no", "guest_name",
      "payment_method", "payment_reference", "status", "currency", "amount", "cashier"]),
    { transaction_count: rows.length },
    collectionTotals(rows),
    ["Payments are shown on their posting dates. Completed refunds reduce net collections on their completion dates."]
  );
}

async function depositLedger(propertyId, parameters) {
  const movements = await collectionMovements(propertyId, parameters);
  const reservations = await reservationsByIds(propertyId, movements.map((entry) => entry.reservation_id));
  const grouped = new Map();
  for (const movement of movements) {
    const reservation = reservations.get(String(movement.reservation_id));
    const key = `${movement.reservation_id}:${movement.currency}`;
    const entry = grouped.get(key) || {
      reservation_no: movement.reservation_no || reservation?.reservation_no || "",
      guest_name: reservation?.booker?.name || "",
      check_in: isoDate(reservation?.check_in),
      check_out: isoDate(reservation?.check_out),
      currency: movement.currency,
      payments_received: 0,
      refunds: 0,
      deposit_amount: 0,
      payment_count: 0,
      refund_count: 0
    };
    if (movement.type === "Refund") {
      entry.refunds = round(entry.refunds - movement.amount);
      entry.refund_count += 1;
    } else {
      entry.payments_received = round(entry.payments_received + movement.amount);
      entry.payment_count += 1;
    }
    entry.deposit_amount = round(entry.payments_received - entry.refunds);
    grouped.set(key, entry);
  }
  const rows = Array.from(grouped.values());
  return tabular(rows, columnsFromKeys(rows, [
    "reservation_no", "guest_name", "check_in", "check_out", "currency", "payments_received",
    "refunds", "deposit_amount", "payment_count", "refund_count"
  ]), { reservation_count: new Set(movements.map((entry) => String(entry.reservation_id))).size }, {
    received_by_currency: groupMoney(rows, "payments_received"),
    refunded_by_currency: groupMoney(rows, "refunds"),
    amount_by_currency: groupMoney(rows, "deposit_amount")
  }, ["Shows net guest collections grouped by reservation and currency for the selected period."]);
}

async function collectionMovements(propertyId, parameters) {
  const [payments, refunds] = await Promise.all([
    financialRecords(ReservationPayment, propertyId, parameters, "posted_at", { status: { $in: ["posted", "refunded"] } }),
    financialRecords(Refund, propertyId, parameters, "completed_at", { status: "completed" })
  ]);
  return [
    ...payments.map((payment) => ({
      payment_id: String(payment._id),
      reservation_id: payment.reservation_id,
      type: payment.status === "refunded" ? "Refund" : "Payment",
      document_no: payment.invoice_no || "",
      posted_at: isoDateTime(payment.posted_at),
      payment_method: payment.payment_method,
      payment_reference: payment.payment_reference,
      status: payment.status,
      currency: payment.currency,
      amount: signedPaymentAmount(payment),
      cashier: payment.posted_by?.name || "System"
    })),
    ...refunds.map((refund) => ({
      payment_id: String(refund._id),
      reservation_id: refund.reservation_id,
      reservation_no: refund.reservation_no,
      type: "Refund",
      document_no: refund.refund_no,
      posted_at: isoDateTime(refund.completed_at),
      payment_method: refund.refund_method,
      payment_reference: refund.reference_number,
      status: refund.status,
      currency: refund.currency,
      amount: -number(refund.amount),
      cashier: refund.completed_by?.name || "System"
    }))
  ].sort((left, right) => left.posted_at.localeCompare(right.posted_at));
}

function collectionTotals(rows) {
  return {
    received_by_currency: groupMoney(rows.filter((row) => row.type === "Payment"), "amount"),
    refunded_by_currency: groupMoney(rows.filter((row) => row.type === "Refund").map((row) => ({ ...row, amount: -row.amount })), "amount"),
    amount_by_currency: groupMoney(rows, "amount")
  };
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
  const [invoices, credits] = await billingDocuments(propertyId, parameters);
  const rows = [
    ...invoices.map((invoice) => revenueRow({
      document: invoice, type: "Invoice", date: invoice.invoice_date, no: invoice.invoice_no, total: invoice.grand_total
    })),
    ...credits.map((credit) => revenueRow({
      document: credit, type: "Credit note", date: credit.credit_date, no: credit.credit_note_no, total: -number(credit.total_credit)
    }))
  ].sort((left, right) => left.document_date.localeCompare(right.document_date));
  return tabular(rows, columnsFromKeys(rows, [
    "document_date", "document_type", "document_no", "reservation_no", "guest_name", "currency", "net_revenue", "tax", "gross_amount"
  ]), { invoice_count: invoices.length, credit_note_count: credits.length }, {
    net_revenue_by_currency: groupMoney(rows, "net_revenue"),
    tax_by_currency: groupMoney(rows, "tax"),
    gross_amount_by_currency: groupMoney(rows, "gross_amount")
  }, ["Shows invoiced revenue and issued credits by document date. Guest receipts are shown in the Collection Report."]);
}

function revenueRow({ document, type, date, no, total }) {
  const tax = (type === "Credit note" ? -1 : 1) * number(document.tax_total);
  return {
    document_date: isoDate(date), document_type: type, document_no: no,
    reservation_no: document.reservation_no,
    guest_name: document.billing_snapshot?.name || document.guest_snapshot?.name || "",
    currency: document.currency,
    net_revenue: round(number(total) - tax), tax, gross_amount: number(total)
  };
}

async function revenueForecast(propertyId, parameters) {
  const query = {
    status: { $in: ["tentative", "confirmed", "checked_in"] },
    $or: [
      { check_out: { $gt: parameters.as_of } },
      { is_day_room: true, check_in: { $gte: parameters.as_of, $lt: nextDay(parameters.date_to) } }
    ]
  };
  const reservations = await reservationRecords(propertyId, parameters, "check_in", query);
  const rows = reservations.map((reservation) => ({
    ...reservationRow(reservation),
    room_revenue: number(reservation.financial_summary?.room_total)
  }));
  return tabular(
    rows,
    columnsFromKeys(rows, ["reservation_no", "check_in", "check_out", "room_count", "status", "currency", "room_revenue"]),
    reservationSummary(rows),
    { room_revenue_by_currency: groupMoney(rows, "room_revenue") },
    ["Forecast uses the saved room subtotal of active reservations in the selected arrival range."]
  );
}

async function invoiceDaybook(propertyId, parameters) {
  const invoices = await issuedInvoices(propertyId, parameters);
  const rows = invoices.map((invoice) => ({
    ...invoiceBalanceRow(invoice),
    status: invoice.status,
    subtotal: number(invoice.subtotal),
    discount: number(invoice.discount_total),
    tax: number(invoice.tax_total)
  }));
  return tabular(rows, columnsFromKeys(rows, [
    "invoice_no", "invoice_date", "due_date", "reservation_no", "guest_name", "status", "currency",
    "subtotal", "discount", "tax", "grand_total", "credited_amount", "paid_total", "balance"
  ]), { invoice_count: rows.length }, invoiceTotals(rows), [
    "Includes issued invoices by invoice date with their current credits, payments and balances."
  ]);
}

async function profitAndLoss(propertyId, parameters) {
  const [[invoices, credits], purchases, expenses] = await Promise.all([
    billingDocuments(propertyId, parameters),
    financialRecords(Purchase, propertyId, parameters, "purchase_date", { status: { $in: ["to_be_paid", "paid"] } }),
    financialRecords(Expense, propertyId, parameters, "expense_date", { status: "posted" })
  ]);
  const buckets = new Map();
  function add(records, field, amount) {
    for (const record of records) {
      const row = buckets.get(record.currency) || {
        currency: record.currency, invoice_revenue: 0, credit_notes: 0, purchases: 0, expenses: 0
      };
      row[field] = round(row[field] + amount(record));
      buckets.set(record.currency, row);
    }
  }
  add(invoices, "invoice_revenue", (item) => number(item.grand_total) - number(item.tax_total));
  add(credits, "credit_notes", (item) => number(item.total_credit) - number(item.tax_total));
  add(purchases, "purchases", (item) => number(item.amount));
  add(expenses, "expenses", (item) => number(item.amount));
  const rows = Array.from(buckets.values(), (row) => ({
    ...row,
    net_revenue: round(row.invoice_revenue - row.credit_notes),
    total_costs: round(row.purchases + row.expenses),
    profit: round(row.invoice_revenue - row.credit_notes - row.purchases - row.expenses)
  })).sort((left, right) => left.currency.localeCompare(right.currency));
  return tabular(rows, columnsFromKeys(rows, [
    "currency", "invoice_revenue", "credit_notes", "net_revenue", "purchases", "expenses", "total_costs", "profit"
  ]), {}, { profit_by_currency: groupMoney(rows, "profit") }, [
    "Operational Profit & Loss uses issued invoices and credit notes excluding their tax, plus recorded purchases and expenses. Currencies are shown separately.",
    "Guest payments, refunds, supplier payments and cash advances do not add a second revenue or cost. Recorded staff expenses are included."
  ]);
}

async function customerBalanceSummary(propertyId, parameters) {
  const invoices = await issuedInvoices(propertyId, parameters);
  const rows = invoices.map(invoiceBalanceRow).filter((row) => row.balance > 0);
  return tabular(rows, columnsFromKeys(rows, [
    "invoice_no", "invoice_date", "due_date", "reservation_no", "guest_name", "currency",
    "grand_total", "credited_amount", "paid_total", "balance"
  ]), { unpaid_invoice_count: rows.length }, moneyTotals(rows, "balance"), [
    "Shows current outstanding invoice balances for the selected invoice date range."
  ]);
}

async function arAgingSummary(propertyId, parameters) {
  const invoices = await Invoice.find({
    property_id: propertyId,
    status: { $in: ISSUED_INVOICE_STATUSES },
    invoice_date: { $lt: nextDay(parameters.as_of) },
    ...(parameters.currency ? { currency: parameters.currency } : {})
  }).sort({ due_date: 1, _id: 1 }).lean();
  const rows = invoices.map((invoice) => {
    const row = invoiceBalanceRow(invoice);
    const dueDate = dateOnly(row.due_date || row.invoice_date, "due_date");
    const age = Math.max(0, daysBetween(dueDate, parameters.as_of));
    return {
      ...row,
      days_outstanding: age,
      aging_bucket: age === 0 ? "Current" : age <= 30 ? "1-30" : age <= 60 ? "31-60" : age <= 90 ? "61-90" : "91+"
    };
  }).filter((row) => row.balance > 0);
  return tabular(rows, columnsFromKeys(rows, [
    "invoice_no", "reservation_no", "guest_name", "due_date", "days_outstanding", "aging_bucket", "currency", "balance"
  ]), { unpaid_invoice_count: rows.length, as_of: isoDate(parameters.as_of) }, moneyTotals(rows, "balance"), [
    "As Of sets the invoice cutoff and measures age from the invoice due date. Balances reflect the latest posted payments and credits."
  ]);
}

async function inHouseGuestLedger(propertyId, parameters) {
  const reservations = await Reservation.find({
    property_id: propertyId,
    deleted_at: { $exists: false },
    status: "checked_in"
  }).sort({ check_in: 1 }).lean();
  const invoices = await Invoice.find({
    property_id: propertyId,
    reservation_id: { $in: reservations.map((reservation) => reservation._id) },
    status: { $in: ISSUED_INVOICE_STATUSES }
  }).sort({ invoice_date: 1, _id: 1 }).lean();
  const byReservation = new Map();
  for (const invoice of invoices) {
    const key = String(invoice.reservation_id);
    if (!byReservation.has(key)) byReservation.set(key, []);
    byReservation.get(key).push(invoice);
  }
  const rows = reservations.flatMap((reservation) => {
    const stay = reservationRow(reservation);
    const issued = byReservation.get(String(reservation._id)) || [];
    const candidates = issued.length ? issued.map(invoiceBalanceRow) : [{
      invoice_no: "", currency: stay.currency, grand_total: 0, credited_amount: 0, paid_total: 0, balance: 0
    }];
    return candidates.filter((invoice) => !parameters.currency || invoice.currency === parameters.currency)
      .map((invoice) => ({
        reservation_no: stay.reservation_no, guest_name: stay.guest_name,
        check_in: stay.check_in, check_out: stay.check_out, ...invoice
      }));
  });
  const shown = new Set(rows.map((row) => row.reservation_no));
  return tabular(rows, columnsFromKeys(rows, [
    "reservation_no", "guest_name", "check_in", "check_out", "invoice_no", "currency",
    "grand_total", "credited_amount", "paid_total", "balance"
  ]), {
    in_house_reservations: shown.size,
    in_house_rooms: reservations.filter((item) => shown.has(item.reservation_no)).reduce((total, item) => total + item.rooms.length, 0)
  }, invoiceTotals(rows), [
    "Shows guests currently checked in, with balances from issued invoices. A blank invoice number means the stay has no issued invoice."
  ]);
}

async function travelAgentPerformance(propertyId, parameters) {
  const reservations = await reservationRecords(propertyId, parameters, "check_in", {
    "travel_agent.name": { $exists: true, $ne: "" },
    status: { $nin: ["cancelled", "no_show"] }
  });
  const agents = new Map();
  for (const reservation of reservations) {
    const agentId = reservation.travel_agent.travel_agent_id || reservation.travel_agent.name.toLowerCase();
    const key = `${agentId}:${reservation.currency}`;
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
  return tabular(rows, columnsFromRows(rows), {
    travel_agent_count: new Set(rows.map((row) => row.travel_agent_id || row.travel_agent.toLowerCase())).size,
    reservation_count: sum(rows, "reservations")
  }, {
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
  const endDate = nextDay(parameters.date_to);
  const projection = { rooms: 1, check_in: 1, check_out: 1, is_day_room: 1, status: 1 };
  const [roomTypes, reservations, blocks] = await Promise.all([
    RoomType.find({ property_id: propertyId, active: true }, { physical_rooms: 1 }).lean(),
    Reservation.find({
      property_id: propertyId,
      deleted_at: { $exists: false },
      status: { $in: [...Reservation.ACTIVE_RESERVATION_STATUSES, "checked_out"] },
      ...reservationOverlapDateQuery(parameters.date_from, endDate)
    }, projection).lean(),
    BusinessBlock.find({
      property_id: propertyId,
      deleted_at: { $exists: false },
      status: "active",
      check_in: { $lt: endDate },
      check_out: { $gt: parameters.date_from }
    }, { allocations: 1, check_in: 1, check_out: 1 }).lean()
  ]);
  const capacities = roomTypes.map((type) => ({
    id: String(type._id),
    sellable: type.physical_rooms.filter((room) =>
      room.active && !["maintenance", "out_of_order"].includes(room.operational_status)
    ).length
  }));
  const totalRooms = sum(capacities, "sellable");
  const blockedReservations = reservations.filter((item) => item.status === "blocked");
  const rows = eachDay(parameters.date_from, parameters.date_to).map((date) => {
    const { usedByType, heldByType } = inventoryUsageForDay(date.getTime(), reservations, blocks);
    const { usedByType: blockedByType } = inventoryUsageForDay(date.getTime(), blockedReservations, []);
    let occupied = 0;
    let blocked = 0;
    let held = 0;
    let available = 0;
    for (const { id, sellable } of capacities) {
      const used = usedByType.get(id) ?? 0;
      const blockedCount = blockedByType.get(id) ?? 0;
      const heldCount = heldByType.get(id) ?? 0;
      occupied += Math.min(sellable, used - blockedCount);
      blocked += blockedCount;
      held += heldCount;
      available += Math.max(0, sellable - used - heldCount);
    }
    return {
      date: isoDate(date),
      total_rooms: totalRooms,
      occupied_rooms: occupied,
      blocked_rooms: blocked,
      business_block_holds: held,
      available_rooms: available,
      occupancy_percentage: totalRooms ? round((occupied / totalRooms) * 100) : 0
    };
  });
  return tabular(rows, columnsFromRows(rows), { days: rows.length, total_rooms: totalRooms }, {
    average_occupancy_percentage: rows.length ? round(sum(rows, "occupancy_percentage") / rows.length) : 0
  }, [
    "Uses current sellable room capacity and all booking currencies. Reservations, blocked rooms and remaining business-block holds use inventory on their applicable dates.",
    "Occupancy includes reserved stays and day-use stays. Past dates use current room configuration because room capacity snapshots are not stored."
  ]);
}

function financialRecords(model, propertyId, parameters, dateField, extra) {
  return model.find({
    property_id: propertyId,
    [dateField]: dateRange(parameters),
    ...extra,
    ...(parameters.currency ? { currency: parameters.currency } : {})
  }).sort({ [dateField]: 1, _id: 1 }).lean();
}

function issuedInvoices(propertyId, parameters) {
  return financialRecords(Invoice, propertyId, parameters, "invoice_date", {
    status: { $in: ISSUED_INVOICE_STATUSES }
  });
}

function billingDocuments(propertyId, parameters) {
  return Promise.all([
    issuedInvoices(propertyId, parameters),
    financialRecords(CreditNote, propertyId, parameters, "credit_date", { status: "issued" })
  ]);
}

function invoiceBalanceRow(invoice) {
  const grandTotal = number(invoice.grand_total);
  const credited = number(invoice.credited_amount);
  const paid = number(invoice.paid_amount);
  return {
    invoice_no: invoice.invoice_no,
    invoice_date: isoDate(invoice.invoice_date),
    due_date: isoDate(invoice.due_date),
    reservation_no: invoice.reservation_no,
    guest_name: invoice.billing_snapshot?.name || "",
    currency: invoice.currency,
    grand_total: grandTotal,
    credited_amount: credited,
    paid_total: paid,
    balance: round(Math.max(0, grandTotal - credited - paid))
  };
}

function invoiceTotals(rows) {
  return {
    ...reservationMoneyTotals(rows),
    credited_by_currency: groupMoney(rows, "credited_amount")
  };
}

async function reservationsByIds(propertyId, ids) {
  const uniqueIds = Array.from(new Set(ids.map(String)));
  if (!uniqueIds.length) return new Map();
  const reservations = await Reservation.find({ property_id: propertyId, _id: { $in: uniqueIds } }, {
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

function available(reportType, title, group, description) {
  return { report_type: reportType, title, group, description, available: true, required_modules: [] };
}

function unavailable(reportType, title, group, description, requiredModules) {
  return { report_type: reportType, title, group, description, available: false, required_modules: requiredModules };
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
