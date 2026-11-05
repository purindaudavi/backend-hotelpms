# Property deletion requests

Implemented 2026-10-29 (Asia/Colombo). Deletion means **archive with Restore**,
as chosen by the product owner. No customer property was archived by testing.

## Owner/Admin workflow

1. On **Your properties**, click the small trash icon beside the Owner or
   Administrator badge. Front Desk, Housekeeping and general members do not see
   this control and cannot submit through the API.
2. Enter a contact phone number and reason, then type the current property name.
   The logged-in account name/email and property role are recorded by the server.
3. Submit. The property stays active; the dialog displays a random PDR request
   code shared with the PMS platform-owner review screen.
4. Open **Deletion requests** on Your properties to check the decision. A
   requester can cancel their own pending request. Refresh to check for updates.
   This link remains available to a requester after their last property is
   archived. History is scoped to the submitting account, not all hotel staff.

Only one pending request is allowed per property, including requests submitted
by different administrators. Opening the icon when one is already pending shows
its code and requester, instead of another submission form. Up to five requests
can be submitted per property in 24 hours, including cancelled/rejected requests.

## PMS platform-owner workflow

Open **PMS owner portal → Deletion requests** at
`http://localhost:3000/platform/property-deletion-requests`.

- Select a request to see the code, immutable property ID, submitted/current
  names, requester identity and role snapshot, contact phone and reason.
- **Approve and archive** requires a review note and typing the current name.
  Approval archives the same property and blocks normal hotel access. Rooms,
  reservations, invoices, history and staff memberships are retained. The
  requester's page shows approval and the review note, even after access closes.
- **Reject request** requires a note and does not change the property.
- Use **All properties → Archived → Restore** to reopen the same hotel's
  existing records and staff access. Approval history remains an historical
  receipt; restoring does not turn an approved request back into pending.
- Archived properties still count against their owner's creation allowance.

Hotel Owner/Admin roles do not grant platform review privileges. Only the
server-controlled `User.platform_owner === true` flag authorizes review.

## Integrity and authorization

Submission checks current Owner/Admin authority before bootstrapping the
inventory guard and again inside the transaction. The server ignores claimed
requester identities, roles, status and platform privileges from the browser.
Reference codes are identifiers, not authentication tokens.

Submission, cancellation and review share the property's inventory write guard.
Approval archives the property, updates its guard, closes the request and writes
actor audits in one MongoDB transaction. Approval/cancellation races and repeated
decisions cannot apply two outcomes. Versions reject stale request/property
forms. Approval also rechecks that the requester still has Owner/Admin authority
and the property's owner has not changed since submission. Invalid requests can
be rejected and resubmitted by the current authorized person.

Pending requests do not reserve capacity or close access. New property API
requests are denied after archive; in-flight guarded booking/finance saves cannot
commit after archive wins the guard. Existing archive limits for already
authorized operations that do not use the guard still apply.

Lifecycle events are saved in property audit history, with the PDR code and
verified actor: requested, cancelled, rejected, approved and property archived.
The full reason/review note stays on the request; the property's archive summary
is limited to 1,000 characters and includes its PDR code.

## Rename behavior

No rename approval workflow was added. Owner/Admin can continue renaming through
Property Settings, and the platform owner can rename through All properties.
Both update the same database display-name field. Refresh/reopen Property
Settings to fetch a platform rename. Permanent IDs and linked records stay the
same; cached/open-page labels and literal email-template text have the branding
limits documented in [property management](property-creation-approval.md).

## Acceptance tests

Use a disposable hotel and separate requester/platform browser sessions.

1. Submit from Owner/Admin. Confirm it stays active and both sides show the same
   PDR code. Try submitting a second request; it must show the existing pending
   request. A Front Desk/Housekeeping/outsider API call must return 403.
2. Cancel from the requester's history. Approval of that closed request must fail.
   Submit again, reject with a note and verify the hotel remains active.
3. Submit as an Administrator, revoke/demote that account, then try approval.
   Approval must fail; reject it and have an authorized person resubmit.
4. With a fresh pending request, approve after typing the current property name
   and a review note. Requester history stays accessible, while hotel API access
   closes. Restore through All properties and verify rooms/reservations return.
5. Open the request in two platform sessions. Approve in one and try again in
   the other; the stale attempt must fail. Renaming or editing the property
   during review also requires refreshing and reviewing the latest details.

Verification: 246 backend tests passed, including request authorization,
identity spoofing, duplicate submissions, role revocation, ownership changes,
stale forms, cancellation/review races, retention/restore and daily limits.
Frontend TypeScript and isolated desktop/mobile browser checks passed. The
expanded `npm run smoke:property-approvals` passed 65 real MongoDB checks,
including deletion submission, cancellation, revoked-admin rejection, concurrent
approval, retained rooms/bookings, archive access/guard and restoration. Fixture
accounts, requests, properties, rooms, bookings, guards and audits were removed
and cleanup verified. UI checks use simulated APIs separately from DB checks.

Lists currently return the latest 100 requests per requester and up to 200 per
platform status filter. Refresh is manual; no email/SMS notification or automatic
subscription billing adjustment is part of this workflow. No production frontend
build was run against the active development server.

## API

All routes below require the authenticated workspace account. They are mounted
before tenant access middleware to allow request history after archival.

- GET `/api/property-deletion`: own latest request history.
- GET `/api/property-deletion/properties/:propertyId`: Owner/Admin context and
  minimal pending-request summary for that property.
- POST `/api/property-deletion/properties/:propertyId/requests`: version,
  confirm_name, contact_phone, reason.
- POST `/api/property-deletion/requests/:requestId/cancel`: request version;
  pending request's submitter only.
- GET `/api/property-deletion/review?status=pending`: platform review queue.
- POST `/api/property-deletion/review/:requestId/decision`: decision, request
  version, review note; approval also requires property_version and confirm_name.
