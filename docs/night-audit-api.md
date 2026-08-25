# Night Audit API and Insomnia workflow

## Start the API

Run the backend from `D:\DMS new\hotelbackend`:

```powershell
npm start
```

The default local base URL is `http://localhost:3500`.

Create an Insomnia environment:

```json
{
  "base_url": "http://localhost:3500",
  "property_id": "demo"
}
```

Add these headers to every Night Audit request:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `x-property-id` | `{{ _.property_id }}` |
| `x-user-id` | `insomnia-user` |
| `x-user-name` | `Insomnia Tester` |

The first request for a property initializes its business date. To initialize a specific date, use `?initial_business_date=2026-08-04` only on the first `GET /current` request.

## Recommended request order

1. `GET {{ _.base_url }}/api/health`
2. `GET {{ _.base_url }}/api/night-audit/current?initial_business_date=2026-08-04`
3. Review Front Desk with `POST {{ _.base_url }}/api/night-audit/current/review`:

   ```json
   {
     "step_id": "front-desk-status"
   }
   ```

4. Post room revenue with `POST {{ _.base_url }}/api/night-audit/current/post-room-revenue` and body `{}`.
5. Review payments with `POST {{ _.base_url }}/api/night-audit/current/review`:

   ```json
   {
     "step_id": "payment-reconciliation"
   }
   ```

   Outstanding balances remain visible as acknowledged warnings.

6. Review Housekeeping with `POST {{ _.base_url }}/api/night-audit/current/review-housekeeping` and body `{}`. Dirty or in-progress rooms return `409` and must be completed in Housekeeping first.
7. `POST {{ _.base_url }}/api/night-audit/current/review-channels` with body `{}`. Until a real Channel Manager API is connected, this step is disabled and is not required to close the day.
8. Generate the six-report close pack with `POST {{ _.base_url }}/api/night-audit/current/generate-reports` and body `{}`.
9. Save an optional handover note with `PATCH {{ _.base_url }}/api/night-audit/current/notes`:

   ```json
   {
     "close_note": "Cash and open balances checked; handed over to the morning shift."
   }
   ```

10. Confirm that `night_audit.can_complete` is `true` in `GET /current`.
11. Close the day with `POST {{ _.base_url }}/api/night-audit/current/complete`:

    ```json
    {
      "close_note": "Night Audit completed in Insomnia."
    }
    ```

    This is the final action: it closes the current audit and advances the property's business date by one day.

## Other requests

- Closed audits: `GET {{ _.base_url }}/api/night-audit/history?limit=20`
- One audit: `GET {{ _.base_url }}/api/night-audit/<audit_id>`
- Review a normal step: `POST /current/review` with one of `front-desk-status`, `folio-posting`, `payment-reconciliation`, `housekeeping-close`, `channel-check`, or `audit-reports`.
- Supervisor override: `POST /current/override` with a reason of at least 10 characters and optional exception IDs:

  ```json
  {
    "step_id": "front-desk-status",
    "exception_ids": ["arrival-overdue:REPLACE_WITH_RESERVATION_ID"],
    "reason": "Approved by the duty manager after verifying the late arrival."
  }
  ```

Use an override only for an operational exception that a manager has genuinely approved. The API stores the approver, time, reason, and exception ID.
