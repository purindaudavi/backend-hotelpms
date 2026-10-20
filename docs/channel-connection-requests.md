# Channel setup requests (current workflow)

This is an intake and internal review workflow, not a live OTA connector. Request records are stored in MongoDB for one property. They contain provider, provider property/account ID, setup contact, notes, status, and append-only status history. Do not paste API keys, passwords, tokens, or other credentials into the request form or reviewer notes.

## Hotel owner

1. Sign in and open the hotel.
2. Open **Channel Manager > Request > New request**.
3. Choose Booking.com, Agoda, Expedia, or Custom API. Add the provider's property ID if known, and a contact name/email. Submit.
4. Reopen Request to see the current status and reviewer notes. If the reviewer selects **Needs information**, reply inside that request; the reply is saved in its history and returns it to **In review**. The owner may cancel an open request.

Only the owner of that property can list, create, or cancel its requests. Demo access is read-only. A submitted request does not configure Channels or send data to a provider.

## Internal reviewer

A trusted internal account with the backend `integration_reviewer`, `admin`, or `developer` role signs in and opens **Your properties > Open integration review queue** (or `/integration-review`). The dedicated `integration_reviewer` role does not grant access to hotel operations. Public registration always creates a regular `user`; selecting "Owner / Administrator" on the registration form does not create an internal reviewer. Provision internal reviewer accounts through a controlled administrator process after verifying the account holder's identity.

An operator with backend database access can grant the dedicated role to an existing verified account with `node scripts/grant-integration-reviewer.js --email person@example.com --confirm`. Do not run this for hotel customers. The command is not run automatically during deployment or registration.

The reviewer can see the 200 most recent requests, inspect the hotel and contact, then set **In review**, **Needs information**, **Mapping in progress**, **Awaiting provider access**, or **Rejected**. A note is required for Needs information and Rejected. Each update appears in the owner's Request history. Connected cannot be set manually. Cancelled and Rejected requests are closed.

## Email notification

Set `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, and `MAIL_PASSWORD` in the backend environment. Set `CHANNEL_REQUEST_REVIEW_EMAIL` to the integration team's mailbox. New requests are emailed to that address; status updates are emailed to the request contact. If SMTP or the review address is absent or delivery fails, the database request and history still save, and the UI reports that email was unavailable. Reviewers must check the queue directly in that case. No credentials are included in these emails.

## Still required for a real channel connection

- Official API access, documentation, test credentials, and provider-specific mapping rules.
- A secure credential-onboarding system with production secret management and HTTPS. The current request form intentionally does not collect secrets.
- Real provider connectivity tests, reservation/webhook handling, availability/rate sync, retries, reconciliation, and monitoring.
- A verified server-side Channel connection record and a Channels screen backed by it. The current Channels screen remains browser-local configuration and is **not** changed by a request or review status.

Do not tell a hotel its channel is connected based on this workflow alone.
