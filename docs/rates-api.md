# Rates API

The Rates API stores reusable rate plans in `rate_plans` and date-specific prices and restrictions in `daily_rates`. A room type's `base_rate` remains in `room_types` as its default reference price.

Base URL: `http://localhost:3500/api/rates`

Every request must identify the property using either:

```http
x-property-id: demo
```

or a `property_id=demo` query parameter. POST requests may also include `property_id` in the JSON body.

## 1. Find a MongoDB room type ID

```http
GET http://localhost:3500/api/rooms?property_id=demo&active=true
```

Copy the `_id` of the room type that should receive a price.

## 2. Create a rate plan

```http
POST http://localhost:3500/api/rates
Content-Type: application/json
x-property-id: demo
```

```json
{
  "name": "Standard B&B",
  "code": "BAR-BB",
  "currency": "LKR",
  "meal_plan": "Bed & Breakfast",
  "valid_from": "2026-08-01",
  "valid_to": "2027-07-31",
  "refundable": true,
  "cancellation_policy": "Free cancellation until 24 hours before check-in.",
  "resident": false,
  "sell_mode": "per_room",
  "rate_mode": "manual",
  "active": true,
  "locked": false,
  "room_type_rates": [
    {
      "room_type_id": "<ROOM_TYPE_MONGODB_ID>",
      "amount": 16000
    }
  ]
}
```

Both the plan name and code must be unique inside one property. Add another object to `room_type_rates` for each room type sold through this plan.

## 3. List rate plans

```http
GET http://localhost:3500/api/rates?property_id=demo
```

Optional filters are `active=true`, `currency=LKR`, `code=BAR-BB`, and `search=breakfast`.

## 4. Read or update one rate plan

```http
GET http://localhost:3500/api/rates/<RATE_PLAN_ID>?property_id=demo
```

```http
PATCH http://localhost:3500/api/rates/<RATE_PLAN_ID>
Content-Type: application/json
x-property-id: demo
```

```json
{
  "cancellation_policy": "Free cancellation until 48 hours before check-in.",
  "room_type_rates": [
    {
      "room_type_id": "<ROOM_TYPE_MONGODB_ID>",
      "amount": 16500
    }
  ]
}
```

When `locked` is true, unlock the plan with a separate request before changing its configuration or prices:

```json
{ "locked": false }
```

Disable an old plan instead of deleting it when reservations already reference it:

```json
{ "active": false }
```

## 5. Save date-specific prices or restrictions

This replaces or creates the matching room-type/date rows.

```http
PUT http://localhost:3500/api/rates/<RATE_PLAN_ID>/daily-rates
Content-Type: application/json
x-property-id: demo
```

```json
{
  "daily_rates": [
    {
      "room_type_id": "<ROOM_TYPE_MONGODB_ID>",
      "date": "2026-08-10",
      "amount": 18000,
      "stop_sell": false,
      "minimum_stay": 2,
      "maximum_stay": 5,
      "closed_to_arrival": false,
      "closed_to_departure": false,
      "notes": "Weekend price"
    },
    {
      "room_type_id": "<ROOM_TYPE_MONGODB_ID>",
      "date": "2026-08-11",
      "amount": 19000
    }
  ]
}
```

Daily rates must be inside the plan's validity period and can only reference room types configured on the plan.

Read a date range:

```http
GET http://localhost:3500/api/rates/<RATE_PLAN_ID>/daily-rates?property_id=demo&date_from=2026-08-01&date_to=2026-08-31
```

## 6. Ask the backend for a reservation quote

```http
POST http://localhost:3500/api/rates/quote
Content-Type: application/json
x-property-id: demo
```

```json
{
  "rate_plan_id": "<RATE_PLAN_ID>",
  "room_type_id": "<ROOM_TYPE_MONGODB_ID>",
  "check_in": "2026-08-10",
  "check_out": "2026-08-13",
  "day_room": false
}
```

The response includes a checkout-exclusive nightly breakdown:

```json
{
  "quote": {
    "currency": "LKR",
    "nights": 3,
    "nightly_rates": [
      { "date": "2026-08-10", "amount": 18000, "source": "daily_rate" },
      { "date": "2026-08-11", "amount": 19000, "source": "daily_rate" },
      { "date": "2026-08-12", "amount": 16000, "source": "rate_plan" }
    ],
    "average_nightly_rate": 17666.666666666668,
    "total": 53000
  }
}
```

The quote rejects disabled plans, uncovered dates, stop-sell dates, closed arrival/departure rules, and minimum/maximum-stay violations.

## Testing

Run all automated tests and syntax checks:

```powershell
npm run check
npm test
```

Run the live Atlas smoke test. It creates and removes temporary rate records:

```powershell
npm run smoke:rates
```
