const DocumentCounter = require("../db_models/document-counter.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const CreditNote = require("../db_models/credit-note.model");
const Refund = require("../db_models/refund.model");
const Reservation = require("../db_models/booking.model");
const { money } = require("../db_models/invoice.model");
const { mealAllocationBreakdown } = require("./meal-allocation.service");

async function nextDocumentNumber({ propertyId, documentType, date = new Date(), session }) {
  const year = new Date(date).getUTCFullYear();
  const prefixes = { invoice: "INV", credit_note: "CN", refund: "RF" };
  const prefix = prefixes[documentType];
  if (!prefix) throw new Error(`Unsupported financial document type: ${documentType}`);
  const filter = {
    property_id: propertyId,
    document_type: documentType,
    year
  };
  let counter;
  try {
    counter = await DocumentCounter.findOneAndUpdate(
      filter,
      {
        $inc: { sequence: 1 },
        $setOnInsert: filter
      },
      { returnDocument: "after", upsert: true, session }
    );
  } catch (error) {
    // Two first documents can race while creating the counter. The unique
    // index chooses a winner; the loser safely increments the existing row.
    if (error.code !== 11000) throw error;
    counter = await DocumentCounter.findOneAndUpdate(
      filter,
      { $inc: { sequence: 1 } },
      { returnDocument: "after", session }
    );
  }
  return `${prefix}-${year}-${String(counter.sequence).padStart(6, "0")}`;
}

function buildAccommodationLines(reservation) {
  const nights = reservation.is_day_room
    ? 1
    : Math.max(Math.ceil((reservation.check_out - reservation.check_in) / 86_400_000), 1);

  return reservation.rooms.flatMap((room) => {
    const mealLines = mealAllocationBreakdown(room);
    const nightlyMealTotal = mealLines.reduce((total, line) => total + line.amount, 0);
    const accommodationRate = room.is_complimentary
      ? 0
      : money(Math.max(Number(room.effective_nightly_rate || 0) - nightlyMealTotal, 0));
    const stayDescription = reservation.is_day_room
      ? "Day use"
      : `${nights} night${nights === 1 ? "" : "s"}`;
    const accommodation = {
      source_type: "accommodation",
      source_id: String(room._id),
      service_date: reservation.check_in,
      description: [
        room.room_type_name,
        room.room_number ? `Room ${room.room_number}` : "",
        stayDescription
      ].filter(Boolean).join(" - "),
      room_number: room.room_number,
      quantity: nights,
      unit_price: accommodationRate,
      discount_amount: 0,
      tax_rate: 0
    };
    const meals = mealLines.map(({ meal, amount }) => ({
      source_type: "meal",
      source_id: `meal-allocation:${String(room._id)}:${meal}`,
      service_date: reservation.check_in,
      description: [
        capitalize(meal),
        room.meal_allocation_snapshot.name,
        room.room_number ? `Room ${room.room_number}` : room.room_type_name
      ].filter(Boolean).join(" - "),
      room_number: room.room_number,
      quantity: nights,
      unit_price: amount,
      discount_amount: 0,
      tax_rate: 0
    }));
    return [accommodation, ...meals];
  });
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

async function refreshInvoiceBalances(invoice, session) {
  const [payments, issuedCredits, completedRefunds] = await Promise.all([
    ReservationPayment.find({
      property_id: invoice.property_id,
      invoice_id: invoice._id,
      status: { $in: ["posted", "refunded"] }
    }).session(session),
    CreditNote.find({
      property_id: invoice.property_id,
      invoice_id: invoice._id,
      status: "issued"
    }).session(session),
    Refund.find({
      property_id: invoice.property_id,
      invoice_id: invoice._id,
      status: "completed"
    }).session(session)
  ]);

  const received = payments.reduce(
    (total, payment) => total + (payment.status === "refunded" ? -payment.amount : payment.amount),
    0
  );
  const refunded = completedRefunds.reduce((total, refund) => total + refund.amount, 0);
  invoice.paid_amount = money(Math.max(received - refunded, 0));
  invoice.credited_amount = money(issuedCredits.reduce(
    (total, credit) => total + credit.total_credit,
    0
  ));

  if (!["draft", "voided"].includes(invoice.status)) {
    invoice.status = calculatedInvoiceStatus(invoice);
  }
  await invoice.save({ session });
  return invoice;
}

async function refreshReservationPaidTotal(reservationId, propertyId, session) {
  const [reservation, payments, refunds] = await Promise.all([
    Reservation.findOne({ _id: reservationId, property_id: propertyId }).session(session),
    ReservationPayment.find({
      property_id: propertyId,
      reservation_id: reservationId,
      status: { $in: ["posted", "refunded"] }
    }).session(session),
    Refund.find({
      property_id: propertyId,
      reservation_id: reservationId,
      status: "completed"
    }).session(session)
  ]);
  if (!reservation) return null;
  const received = payments.reduce(
    (total, payment) => total + (payment.status === "refunded" ? -payment.amount : payment.amount),
    0
  );
  const refunded = refunds.reduce((total, refund) => total + refund.amount, 0);
  reservation.financial_summary.paid_total = money(Math.max(received - refunded, 0));
  await reservation.save({ session });
  return reservation;
}

function calculatedInvoiceStatus(invoice) {
  const adjustedTotal = money(Math.max(invoice.grand_total - invoice.credited_amount, 0));
  if (invoice.credited_amount >= invoice.grand_total) return "credited";
  if (invoice.paid_amount >= adjustedTotal && adjustedTotal > 0) return "paid";
  if (invoice.paid_amount > 0) return "partially_paid";
  return "issued";
}

function serializeFinancialDocument(document) {
  const value = document.toObject({ virtuals: true });
  value.version = value.__v;
  delete value.__v;
  return value;
}

module.exports = {
  buildAccommodationLines,
  calculatedInvoiceStatus,
  nextDocumentNumber,
  refreshInvoiceBalances,
  refreshReservationPaidTotal,
  serializeFinancialDocument
};
