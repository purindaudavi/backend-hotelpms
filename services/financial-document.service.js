const DocumentCounter = require("../db_models/document-counter.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const CreditNote = require("../db_models/credit-note.model");
const { money } = require("../db_models/invoice.model");

async function nextDocumentNumber({ propertyId, documentType, date = new Date(), session }) {
  const year = new Date(date).getUTCFullYear();
  const prefix = documentType === "credit_note" ? "CN" : "INV";
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

  return reservation.rooms.map((room) => ({
    source_type: "accommodation",
    source_id: String(room._id),
    service_date: reservation.check_in,
    description: [
      room.room_type_name,
      room.room_number ? `Room ${room.room_number}` : "",
      reservation.is_day_room ? "Day use" : `${nights} night${nights === 1 ? "" : "s"}`
    ].filter(Boolean).join(" - "),
    room_number: room.room_number,
    quantity: nights,
    unit_price: room.is_complimentary ? 0 : room.effective_nightly_rate,
    discount_amount: 0,
    tax_rate: 0
  }));
}

async function refreshInvoiceBalances(invoice, session) {
  const [payments, issuedCredits] = await Promise.all([
    ReservationPayment.find({
      property_id: invoice.property_id,
      invoice_id: invoice._id,
      status: { $in: ["posted", "refunded"] }
    }).session(session),
    CreditNote.find({
      property_id: invoice.property_id,
      invoice_id: invoice._id,
      status: "issued"
    }).session(session)
  ]);

  invoice.paid_amount = money(Math.max(payments.reduce(
    (total, payment) => total + (payment.status === "refunded" ? -payment.amount : payment.amount),
    0
  ), 0));
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
  serializeFinancialDocument
};
