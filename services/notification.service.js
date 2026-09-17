const Reservation = require("../db_models/booking.model");
const Invoice = require("../db_models/invoice.model");
const CreditNote = require("../db_models/credit-note.model");
const Refund = require("../db_models/refund.model");
const Withdrawal = require("../db_models/withdrawal.model");
const Purchase = require("../db_models/purchase.model");
const Expense = require("../db_models/expense.model");
const ReservationPayment = require("../db_models/reservation-payment.model");
const FinancialTransaction = require("../db_models/financial-transaction.model");

const notificationSources = [
  {
    type: "booking",
    model: Reservation,
    select: "reservation_no status booking_source booker.name created_at",
    build: (record, propertyId) => ({
      title: `New booking ${record.reservation_no}`,
      message: joinDetails(record.booker?.name, record.booking_source, readable(record.status)),
      reference: record.reservation_no,
      href: entityHref(propertyId, "reservation/bookings", record.reservation_no)
    })
  },
  {
    type: "invoice",
    model: Invoice,
    select: "invoice_no status currency grand_total billing_snapshot.name created_at",
    build: (record, propertyId) => ({
      title: `Invoice ${record.invoice_no} created`,
      message: joinDetails(record.billing_snapshot?.name, readable(record.status), money(record.grand_total, record.currency)),
      reference: record.invoice_no,
      href: entityHref(propertyId, "financials/invoices", record.invoice_no)
    })
  },
  {
    type: "payment",
    model: ReservationPayment,
    select: "invoice_no reservation_id amount currency payment_method status posted_at created_at",
    build: (record, propertyId) => ({
      title: record.invoice_no ? `Payment posted for ${record.invoice_no}` : "Reservation payment posted",
      message: joinDetails(money(record.amount, record.currency), readable(record.payment_method), readable(record.status)),
      reference: record.invoice_no || String(record.reservation_id || ""),
      href: record.invoice_no
        ? entityHref(propertyId, "financials/invoices", record.invoice_no)
        : `/properties/${encodeURIComponent(propertyId)}/financials/transactions`
    })
  },
  {
    type: "credit_note",
    model: CreditNote,
    select: "credit_note_no invoice_no status currency total_credit created_at",
    build: (record, propertyId) => ({
      title: `Credit note ${record.credit_note_no} created`,
      message: joinDetails(`For ${record.invoice_no}`, readable(record.status), money(record.total_credit, record.currency)),
      reference: record.credit_note_no,
      href: entityHref(propertyId, "financials/credit-notes", record.credit_note_no)
    })
  },
  {
    type: "refund",
    model: Refund,
    select: "refund_no invoice_no status currency amount requested_at created_at",
    build: (record, propertyId) => ({
      title: `Refund ${record.refund_no} requested`,
      message: joinDetails(`For ${record.invoice_no}`, readable(record.status), money(record.amount, record.currency)),
      reference: record.refund_no,
      href: entityHref(propertyId, "financials/refunds", record.refund_no)
    })
  },
  {
    type: "withdrawal",
    model: Withdrawal,
    select: "withdrawal_no paid_to status currency amount created_at",
    build: (record, propertyId) => ({
      title: `Withdrawal ${record.withdrawal_no} recorded`,
      message: joinDetails(record.paid_to, readable(record.status), money(record.amount, record.currency)),
      reference: record.withdrawal_no,
      href: entityHref(propertyId, "financials/withdrawals", record.withdrawal_no)
    })
  },
  {
    type: "purchase",
    model: Purchase,
    select: "purchase_no supplier_name status currency amount created_at",
    build: (record, propertyId) => ({
      title: `Purchase ${record.purchase_no} created`,
      message: joinDetails(record.supplier_name, readable(record.status), money(record.amount, record.currency)),
      reference: record.purchase_no,
      href: entityHref(propertyId, "financials/purchases", record.purchase_no)
    })
  },
  {
    type: "expense",
    model: Expense,
    select: "expense_no expense_type status currency amount created_at",
    build: (record, propertyId) => ({
      title: `Expense ${record.expense_no} recorded`,
      message: joinDetails(record.expense_type, readable(record.status), money(record.amount, record.currency)),
      reference: record.expense_no,
      href: entityHref(propertyId, "financials/expenses", record.expense_no)
    })
  },
  {
    type: "transaction",
    model: FinancialTransaction,
    select: "transaction_no source_type source_number status currency amount created_at",
    build: (record, propertyId) => ({
      title: `Transaction ${record.transaction_no} posted`,
      message: joinDetails(readable(record.source_type), record.source_number, money(record.amount, record.currency)),
      reference: record.transaction_no,
      href: entityHref(propertyId, "financials/transactions", record.transaction_no)
    })
  }
];

async function listPropertyNotifications(propertyId, limit = 30) {
  const perSourceLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const batches = await Promise.all(notificationSources.map(async (source) => {
    const records = await source.model
      .find({ property_id: propertyId })
      .sort({ created_at: -1 })
      .limit(perSourceLimit)
      .select(source.select)
      .lean();

    return records.map((record) => buildNotification(source, record, propertyId));
  }));

  return batches
    .flat()
    .filter((item) => item.timestamp)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, perSourceLimit);
}

function buildNotification(source, record, propertyId) {
  const details = source.build(record, propertyId);
  return {
    id: `${source.type}:${String(record._id)}`,
    type: source.type,
    ...details,
    timestamp: new Date(record.created_at || record.posted_at || Date.now()).toISOString()
  };
}

function entityHref(propertyId, section, reference) {
  return `/properties/${encodeURIComponent(propertyId)}/${section}/${encodeURIComponent(reference)}`;
}

function joinDetails(...values) {
  return values.filter((value) => String(value || "").trim()).join(" · ");
}

function readable(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function money(amount, currency) {
  return `${String(currency || "LKR").toUpperCase()} ${Number(amount || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

module.exports = {
  buildNotification,
  entityHref,
  listPropertyNotifications,
  notificationSources
};
