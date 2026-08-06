# Invoices and credit notes API

This backend treats an invoice as an official bill for one reservation. A credit note is a correction that reduces an already-issued invoice. Existing reservation payments/transactions remain separate and are linked to an invoice only when a payment is posted through the invoice endpoint.

Base URL: `http://localhost:3500/api`

Send the property on every request using one of these options:

- Header: `x-property-id: demo` (recommended)
- Query: `?property_id=demo`
- JSON body: `"property_id": "demo"`

Optional audit headers:

- `x-user-id: staff-001`
- `x-user-name: Asiri Perera`
- `x-user-email: asiri@example.com`

## Normal workflow

1. Create a draft invoice from a saved reservation.
2. Review/edit its bill-to details and lines.
3. Issue it. Issued invoices are locked.
4. Post payments against it.
5. If an issued invoice is wrong, issue a credit note. Do not edit the invoice.

MongoDB creates these collections automatically:

- `invoices`
- `credit_notes`
- `document_counters`
- existing `reservation_payments` stores invoice-linked payments
- existing `booking_audit_logs` stores invoice and credit-note activity

## 1. Create a draft invoice

`POST /api/invoices`

The backend copies the guest, stay dates, physical room numbers, and saved reservation room prices. This snapshot prevents an old invoice from changing when the guest or current rate is edited later.

Minimal JSON body:

```json
{
  "property_id": "demo",
  "reservation_id": "REPLACE_WITH_RESERVATION_OBJECT_ID",
  "due_date": "2026-08-10",
  "terms": "Payment is due before check-out."
}
```

If the reservation does not have `booker.guest_profile_id`, also include:

```json
{
  "guest_id": "REPLACE_WITH_GUEST_OBJECT_ID"
}
```

To add charges while keeping the automatically generated room charge:

```json
{
  "property_id": "demo",
  "reservation_id": "REPLACE_WITH_RESERVATION_OBJECT_ID",
  "additional_line_items": [
    {
      "source_type": "transport",
      "service_date": "2026-08-10",
      "description": "Airport pickup",
      "quantity": 1,
      "unit_price": 5000,
      "discount_amount": 0,
      "tax_rate": 0
    }
  ]
}
```

`line_items` replaces all automatically generated lines. `additional_line_items` appends to the automatic accommodation lines.

The backend generates a readable number such as `INV-2026-000001` and calculates all totals. Do not send invoice numbers or calculated totals from the frontend.

## 2. View or find invoices

- List: `GET /api/invoices?property_id=demo`
- Search: `GET /api/invoices?property_id=demo&search=Nimal`
- Filter: `GET /api/invoices?property_id=demo&status=issued&date_from=2026-08-01&date_to=2026-08-31`
- One invoice: `GET /api/invoices/INVOICE_OBJECT_ID?property_id=demo`

The single-invoice response also contains linked payments, credit notes, and audit logs.

## 3. Edit and issue an invoice

Edit a draft:

`PATCH /api/invoices/INVOICE_OBJECT_ID`

```json
{
  "property_id": "demo",
  "due_date": "2026-08-15",
  "notes": "Thank you for staying with us."
}
```

Issue it:

`POST /api/invoices/INVOICE_OBJECT_ID/issue`

```json
{
  "property_id": "demo"
}
```

After issue, the bill is locked. Corrections must use a credit note.

## 4. Post or void an invoice payment

Post a payment:

`POST /api/invoices/INVOICE_OBJECT_ID/payments`

```json
{
  "property_id": "demo",
  "amount": 6500,
  "payment_method": "cash",
  "payment_reference": "CASH-1001",
  "notes": "Paid at front desk"
}
```

The amount cannot exceed `balance_due`. The invoice moves through `issued`, `partially_paid`, and `paid` automatically. The reservation's paid total is also refreshed.

View payments:

`GET /api/invoices/INVOICE_OBJECT_ID/payments?property_id=demo`

Void a mistaken payment:

`POST /api/invoices/INVOICE_OBJECT_ID/payments/PAYMENT_OBJECT_ID/void`

```json
{
  "property_id": "demo",
  "reason": "Payment was entered twice."
}
```

## 5. Create and issue a credit note

First copy the invoice line `_id` from `GET /api/invoices/INVOICE_OBJECT_ID`.

Create a draft:

`POST /api/credits`

```json
{
  "property_id": "demo",
  "invoice_id": "REPLACE_WITH_INVOICE_OBJECT_ID",
  "reason_code": "rate_correction",
  "reason": "The room was charged at the wrong rate.",
  "line_items": [
    {
      "invoice_line_id": "REPLACE_WITH_INVOICE_LINE_OBJECT_ID",
      "category": "accommodation",
      "description": "Room-rate correction",
      "quantity": 2,
      "unit_amount": 500,
      "tax_amount": 0
    }
  ]
}
```

Allowed reason codes:

- `billing_error`
- `cancelled_service`
- `overcharge`
- `rate_correction`
- `guest_compensation`
- `tax_correction`
- `other`

Issue the credit:

`POST /api/credits/CREDIT_NOTE_OBJECT_ID/issue`

```json
{
  "property_id": "demo"
}
```

The backend generates a number such as `CN-2026-000001`, prevents over-crediting, and updates the invoice's `credited_amount`, `balance_due`, and status.

## 6. View, edit, or void credit notes

- List: `GET /api/credits?property_id=demo`
- One: `GET /api/credits/CREDIT_NOTE_OBJECT_ID?property_id=demo`
- Edit draft: `PATCH /api/credits/CREDIT_NOTE_OBJECT_ID`
- Void: `POST /api/credits/CREDIT_NOTE_OBJECT_ID/void`

Void JSON:

```json
{
  "property_id": "demo",
  "reason": "The credit note was created for the wrong invoice."
}
```

Voiding an issued credit note removes its value from the invoice and recalculates the invoice status.

## 7. Void an invoice

`POST /api/invoices/INVOICE_OBJECT_ID/void`

```json
{
  "property_id": "demo",
  "reason": "Duplicate invoice."
}
```

Payments and issued credit notes must be voided first. This protects the financial audit trail.

## Important field meanings

- `invoice_no`: server-generated bill number.
- `reservation_no`: readable reservation reference copied from the reservation.
- `billing_snapshot`: who was billed at the time of issue.
- `line_items`: room and extra charges.
- `grand_total`: subtotal minus discounts plus tax.
- `paid_amount`: posted payments less refunds.
- `credited_amount`: issued credit notes.
- `balance_due`: amount the guest still owes.
- `refund_due`: amount that should be returned when credits exceed the adjusted unpaid amount.
- `status`: workflow state; it is not a free-text field.

Credit notes are not payments. A credit reduces what is owed; a payment records money received. A refund can remain in the transaction/payment workflow and should reference the invoice/payment it reverses.
