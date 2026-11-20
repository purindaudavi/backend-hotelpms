const Invoice = require("../db_models/invoice.model");
const CreditNote = require("../db_models/credit-note.model");
const Reservation = require("../db_models/booking.model");
const { money } = Invoice;
const { buildAccommodationLines } = require("./financial-document.service");
const { DAY_MS, inventoryDay, inventoryRange } = require("./booking-inventory-dates.service");

const eligibleStatuses = ["confirmed", "checked_in"];
const postedStatuses = ["issued", "partially_paid", "paid", "credited"];
const reservationFields = "property_id reservation_no status check_in check_out is_day_room currency rooms booker.name financial_summary.grand_total";
const invoiceFields = "reservation_id invoice_no status currency grand_total paid_amount credited_amount stay_snapshot extension_of stay_override line_items.source_type line_items.source_id line_items.total_amount";
const dateLabel = (day) => new Date(day).toISOString().slice(0, 10);
const lineTotal = (lines) => money(lines.reduce((sum, line) => sum + money(line.quantity * line.unit_price), 0));

function isStayCharge(line) {
  return line.source_type === "accommodation" ||
    (line.source_type === "meal" && String(line.source_id || "").startsWith("meal-allocation:"));
}

function stayInvoices(invoices) {
  return invoices.filter((invoice) => invoice.status !== "voided" && invoice.line_items?.some(isStayCharge));
}

function stayChargeTotal(invoice) {
  return money(invoice.line_items.filter(isStayCharge).reduce((sum, line) => sum + Number(line.total_amount || 0), 0));
}

function refundDue(invoice) {
  return money(Math.max(Number(invoice.paid_amount || 0) + Number(invoice.credited_amount || 0) - invoice.grand_total, 0));
}

function removedStayCharge(invoice, reservation) {
  const billed = inventoryRange(invoice.stay_snapshot);
  const requested = inventoryRange(reservation);
  if (Boolean(invoice.stay_snapshot.is_day_room) !== Boolean(reservation.is_day_room)) return stayChargeTotal(invoice);
  const start = Math.max(billed.start, requested.start);
  const end = Math.min(billed.end, requested.end);
  if (end <= start) return stayChargeTotal(invoice);
  const nights = (billed.end - billed.start) / DAY_MS;
  const keptStart = (start - billed.start) / DAY_MS;
  const keptEnd = (end - billed.start) / DAY_MS;
  return invoice.line_items.filter(isStayCharge).reduce((sum, line) => {
    const cents = Math.round(line.total_amount * 100);
    const extra = cents % nights;
    const keptCents = Math.floor(cents / nights) * (keptEnd - keptStart) + Math.min(extra, keptEnd) - Math.min(extra, keptStart);
    return money(sum + (cents - keptCents) / 100);
  }, 0);
}

async function assertBilledStayDatesCanChange(previous, reservation, session) {
  const before = inventoryRange(previous);
  const after = inventoryRange(reservation);
  if (after.start <= before.start && after.end >= before.end &&
      Boolean(previous.is_day_room) === Boolean(reservation.is_day_room)) return;

  const invoices = stayInvoices(await linkedInvoices(reservation, session));
  for (const invoice of invoices) {
    if (!postedStatuses.includes(invoice.status)) continue;
    const removedAmount = removedStayCharge(invoice, reservation);
    if (removedAmount <= 0) continue;
    let credited = invoice.credited_amount || 0;
    if (credited > 0 && invoice.line_items.some((line) => !isStayCharge(line))) {
      // A credit for a different service must not release an invoiced night.
      const stayLineIds = new Set(invoice.line_items.filter(isStayCharge).map((line) => String(line._id)));
      const credits = await CreditNote.find({ property_id: reservation.property_id, invoice_id: invoice._id, status: "issued" }).session(session);
      credited = money(credits.flatMap((credit) => credit.line_items)
        .filter((line) => stayLineIds.has(String(line.invoice_line_id)))
        .reduce((sum, line) => sum + line.total_amount, 0));
      if (invoice.status === "credited") credited = removedAmount;
    }
    const stillBilled = money(removedAmount - credited);
    const refund = refundDue(invoice);
    if (stillBilled > 0 || refund > 0) {
      const action = stillBilled > 0
        ? `Issue a credit note for the removed stay charges (${invoice.currency} ${stillBilled.toFixed(2)}) and complete any refund due.`
        : `Complete the outstanding refund of ${invoice.currency} ${refund.toFixed(2)}.`;
      throw Object.assign(new Error(`These dates cannot be saved because they remove a night or day-use charge billed on ${invoice.invoice_no}. ${action} Then try updating the reservation again.`), {
        statusCode: 409, code: "BILLED_STAY_DATES"
      });
    }
  }
}

function stayCoverage(reservation, invoices) {
  if (!eligibleStatuses.includes(reservation.status) || reservation.is_day_room) return null;
  const documents = stayInvoices(invoices).filter((invoice) => !invoice.stay_override &&
    !(invoice.extension_of && invoice.status === "credited" && refundDue(invoice) === 0));
  const bases = documents.filter((invoice) => !invoice.extension_of);
  const uncredited = bases.filter((invoice) => invoice.status !== "credited");
  const originals = uncredited.length ? uncredited : bases;
  if (originals.length !== 1) return null;
  const [original] = originals;
  const start = inventoryDay(reservation.check_in);
  const end = inventoryDay(reservation.check_out);
  if (!postedStatuses.includes(original.status) || original.stay_snapshot?.is_day_room ||
      documents.some((invoice) => !invoice.stay_snapshot?.check_in || !invoice.stay_snapshot?.check_out) ||
      inventoryDay(original.stay_snapshot.check_in) !== start) return null;

  const ordered = [original, ...documents.filter((invoice) => invoice.extension_of)
    .sort((a, b) => inventoryDay(a.stay_snapshot.check_in) - inventoryDay(b.stay_snapshot.check_in))];
  let coveredThrough = start;
  let coveredAmount = 0;
  for (const invoice of ordered) {
    const { check_in, check_out, is_day_room } = invoice.stay_snapshot;
    const until = inventoryDay(check_out);
    if (invoice.currency !== reservation.currency || is_day_room ||
        inventoryDay(check_in) !== coveredThrough || until <= coveredThrough || until > end ||
        (invoice.extension_of && String(invoice.extension_of) !== String(original._id))) return null;
    coveredThrough = until;
    coveredAmount = money(coveredAmount + stayChargeTotal(invoice));
  }
  return { original, coveredThrough, coveredAmount, end, documents: ordered };
}

function buildExtensionLines(reservation, from, to) {
  return buildAccommodationLines({
    rooms: reservation.rooms,
    check_in: new Date(from),
    check_out: new Date(to),
    is_day_room: false
  });
}

function getStayExtensionPlan(reservation, invoices) {
  const coverage = stayCoverage(reservation, invoices);
  if (!coverage || coverage.coveredThrough === coverage.end) return null;
  const { original, coveredThrough, coveredAmount, end, documents } = coverage;
  const fullStayTotal = money(reservation.financial_summary?.grand_total || 0);
  const expected = money(fullStayTotal - coveredAmount);
  if (expected <= 0) return null;
  let lines = buildExtensionLines(reservation, coveredThrough, end);
  if (lineTotal(lines) !== expected) {
    // A nightly quote may change the saved average as nights are added.
    // Preserve amounts already invoiced and collect the difference for the
    // same accommodation/meal sources only.
    const fullLines = buildAccommodationLines(reservation);
    if (lineTotal(fullLines) !== fullStayTotal) return null;
    const remainingBySource = new Map(fullLines.map((line) => [chargeKey(line), money(line.quantity * line.unit_price)]));
    const billedSources = new Set();
    for (const invoice of documents) {
      for (const line of invoice.line_items.filter(isStayCharge)) {
        const key = chargeKey(line);
        if (!line.source_id || !remainingBySource.has(key)) return null;
        billedSources.add(key);
        remainingBySource.set(key, money(remainingBySource.get(key) - line.total_amount));
      }
    }
    if ([...remainingBySource].some(([key, total]) => total < 0 || (total > 0 && !billedSources.has(key)))) return null;
    lines = lines.flatMap((line) => {
      const total = remainingBySource.get(chargeKey(line));
      return total > 0 ? [{ ...line, quantity: 1, unit_price: total }] : [];
    });
  }
  const amount = lineTotal(lines);
  if (amount !== expected) return null;
  return {
    original,
    lines,
    preview: {
      reservation_id: String(reservation._id),
      reservation_no: reservation.reservation_no,
      guest_name: reservation.booker?.name || "",
      from_date: dateLabel(coveredThrough),
      to_date: dateLabel(end),
      nights: (end - coveredThrough) / DAY_MS,
      currency: reservation.currency,
      amount
    }
  };
}

function chargeKey(line) {
  return `${line.source_type}:${line.source_id}`;
}

function linkedInvoices(reservation, session) {
  return Invoice.find({
    property_id: reservation.property_id, reservation_id: reservation._id, status: { $ne: "voided" }
  }).session(session || null);
}

async function getPendingStayExtension(reservation, session) {
  if (!eligibleStatuses.includes(reservation.status) || reservation.is_day_room) return null;
  const invoices = await linkedInvoices(reservation, session).select(invoiceFields).lean();
  return getStayExtensionPlan(reservation, invoices)?.preview || null;
}

async function listPendingStayExtensions(propertyId) {
  const reservations = await Reservation.find({
    property_id: propertyId, status: { $in: eligibleStatuses },
    deleted_at: { $exists: false }, is_day_room: { $ne: true }
  }, reservationFields).sort({ check_out: 1, _id: 1 }).lean();
  if (!reservations.length) return [];
  const invoices = await Invoice.find({
    property_id: propertyId, status: { $in: ["draft", ...postedStatuses] },
    reservation_id: { $in: reservations.map((reservation) => reservation._id) },
    "line_items.source_type": "accommodation"
  }, invoiceFields).lean();
  const byReservation = new Map();
  for (const invoice of invoices) {
    const id = String(invoice.reservation_id);
    if (!byReservation.has(id)) byReservation.set(id, []);
    byReservation.get(id).push(invoice);
  }
  return reservations.flatMap((reservation) => {
    const plan = getStayExtensionPlan(reservation, byReservation.get(String(reservation._id)) || []);
    return plan ? [plan.preview] : [];
  });
}

function sameExtension(invoice, expected) {
  return invoice.extension_of && invoice.status !== "credited" &&
    dateLabel(inventoryDay(invoice.stay_snapshot.check_in)) === expected.from_date &&
    dateLabel(inventoryDay(invoice.stay_snapshot.check_out)) === expected.to_date &&
    invoice.currency === expected.currency && invoice.grand_total === expected.amount;
}

function canIssueStayExtension(reservation, invoices, draft) {
  const coverage = reservation && stayCoverage(reservation, invoices);
  if (!coverage || !coverage.documents.some((invoice) => String(invoice._id) === String(draft._id))) return false;
  const expected = money(reservation.financial_summary?.grand_total || 0);
  return coverage.coveredThrough === coverage.end ? coverage.coveredAmount === expected
    : Boolean(getStayExtensionPlan(reservation, invoices));
}

module.exports = {
  isStayCharge, stayInvoices, linkedInvoices, getStayExtensionPlan, getPendingStayExtension,
  listPendingStayExtensions, sameExtension, canIssueStayExtension, assertBilledStayDatesCanChange
};
