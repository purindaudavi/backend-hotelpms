const FinancialTransaction = require("../db_models/financial-transaction.model");
const { writeAuditLog } = require("./booking-audit.service");
const { nextDocumentNumber, serializeFinancialDocument } = require("./financial-document.service");

async function postFinancialTransaction({
  propertyId,
  sourceType,
  sourceId,
  sourceNumber,
  transactionDate = new Date(),
  direction,
  accountingEffect = "neutral",
  amount,
  currency,
  reservationId,
  reservationNo = "",
  roomNumbers = [],
  description,
  actor,
  requestId = "",
  session
}) {
  const existing = await FinancialTransaction.findOne({
    property_id: propertyId,
    source_type: sourceType,
    source_id: sourceId
  }).session(session || null);
  if (existing) return existing;

  const transactionNo = await nextDocumentNumber({
    propertyId,
    documentType: "financial_transaction",
    date: transactionDate,
    session
  });
  const [transaction] = await FinancialTransaction.create([{
    property_id: propertyId,
    transaction_no: transactionNo,
    transaction_date: transactionDate,
    source_type: sourceType,
    source_id: sourceId,
    source_number: sourceNumber,
    direction,
    accounting_effect: accountingEffect,
    amount,
    currency,
    reservation_id: reservationId,
    reservation_no: reservationNo,
    room_numbers: roomNumbers,
    description,
    status: "posted",
    created_by: actor
  }], { session });

  await writeAuditLog({
    propertyId,
    entityType: "financial_transaction",
    entityId: transaction._id,
    action: "financial_transaction_posted",
    description: `${readable(direction)} transaction ${transaction.transaction_no} was posted from ${readable(sourceType)} ${sourceNumber}.`,
    actor,
    requestId,
    session
  });
  return transaction;
}

async function voidFinancialTransaction({
  propertyId,
  sourceType,
  sourceId,
  reason,
  actor,
  requestId = "",
  voidedAt = new Date(),
  session
}) {
  const transaction = await FinancialTransaction.findOne({
    property_id: propertyId,
    source_type: sourceType,
    source_id: sourceId
  }).session(session || null);
  if (!transaction || transaction.status === "voided") return transaction;

  transaction.status = "voided";
  transaction.voided_at = voidedAt;
  transaction.voided_by = actor;
  transaction.void_reason = reason;
  await transaction.save({ session });
  await writeAuditLog({
    propertyId,
    entityType: "financial_transaction",
    entityId: transaction._id,
    action: "financial_transaction_voided",
    description: `Transaction ${transaction.transaction_no} was voided: ${reason}`,
    actor,
    requestId,
    session
  });
  return transaction;
}

function readable(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

module.exports = {
  postFinancialTransaction,
  serializeFinancialTransaction: serializeFinancialDocument,
  voidFinancialTransaction
};
