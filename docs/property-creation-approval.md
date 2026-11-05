# Property creation approval and PMS owner portal

Implemented 2026-10-28 (Asia/Colombo). Every new property now requires an
account-level allowance approved by a PMS platform owner. Hotel Owner/Admin,
Front Desk, Housekeeping, general membership and legacy global roles do not
authorize property creation or platform request review on their own.

## User workflow

1. Register/sign in normally. Public signup cannot choose a platform privilege
   or property allowance. Existing property invitations still grant staff access.
2. Your properties shows owned/approved/available counts. Without an available
   creation slot, Request property access replaces Add property. Property requests
   is also linked here and is available at `/property-requests`.
3. Submit contact name, phone, business/hotel name, total properties requested
   and a business reason. Account name/email come from the verified account.
   Do not submit passwords, API keys or card information.
4. A random `PCR-...` reference code appears in the request list. Only the
   requester and authorized platform reviewers can read the request. The code
   is a tracking reference, not a password, verification code or permission grant.
5. Pending requests may be cancelled by their requester. Only one request may
   be pending per account; submission is limited to five requests in 24 hours.
6. After review, refresh Property requests to see the decision, reviewer note
   and approved total. Go to your properties, refresh and choose Add property.
   The remaining allowance decreases as properties are created. When exhausted,
   request a higher total limit. Staff memberships do not consume this allowance.

## Platform-owner workflow

The protected portal is `/platform/property-requests`. Its link appears in
Your properties only when the server reports platform review permission.

1. Sign in with an explicitly provisioned platform-owner account.
2. Open PMS owner portal and select a pending request. Both sides see the same
   reference code. Review the authenticated account identity, provided contact
   name/phone, business, reason, current allowance and current owned count.
3. Contact/business verification is manual. The submitted phone is not OTP-verified.
4. Set Approved total properties and choose Approve limit, or supply a reason
   and Reject request. Approval may be lower than requested, but must cover
   already-owned properties and be between 1 and 1,000. The limit is a total,
   not an additional allowance. A request for 6 with 3 already owned, approved
   at 6, permits 3 more creations.
5. Status filters show pending, approved, rejected, cancelled or all requests
   (up to 200 recent records per selection). Closed decisions cannot be replayed
   or edited. Further quota changes use another reviewed request.

The portal does not grant platform access to other people, provide access to
customers' guest/financial records, activate paid billing, or create properties
automatically. Platform reviewers' own property creation also requires a quota.
No email/SMS is sent by this workflow; users track the status in the app.

## Provisioning platform access

`User.platform_owner` is a separate server-controlled boolean. It does not
change global `role`, property ownership or membership. Registration explicitly
whitelists its four account fields, and no public endpoint edits this flag.
The user explicitly nominated one existing registered account during setup;
only that nominated real account was granted the flag. Its identity is stored
in the database, not hardcoded in the frontend or inferred from hotel ownership.

Trusted server operators can use:

```powershell
node scripts/set-platform-owner.js --email ACCOUNT_EMAIL --enable
node scripts/set-platform-owner.js --email ACCOUNT_EMAIL --enable --apply
node scripts/set-platform-owner.js --email ACCOUNT_EMAIL --disable --apply
```

Without --apply this only checks the registered account and previews the change.
An apply updates the flag and writes a platform_access_audits record in one
transaction. No account is silently registered; if missing, register normally
first. Never grant this privilege based on an untrusted browser field.

## Enforcement and existing accounts

- New accounts and existing records with no allowance have a zero creation
  limit. Existing hotels and property roles are retained; there is no automatic
  allowance for being an existing hotel owner or administrator.
- POST `/api/properties` locks the account document, checks the fresh approved
  limit and counts owned properties in the same transaction as creating the
  property. Supplying owner IDs, quotas or platform flags cannot bypass this.
- All owned properties, including inactive properties, count. Merely being a
  member/administrator at another owner's hotel does not count.
- Submission, cancellation and approval use the same account write guard as
  creation. MongoDB transaction retries serialize competing final-slot creates
  and conflicting review/cancellation decisions.
- Request decisions save the previous/new limit, authenticated reviewer identity,
  review note and decision time. Request ownership and platform privileges are
  checked on the server. Possessing another person's reference code gives no
  read, cancel, approve or creation permission.
- A lower approved quota does not delete existing hotels. This initial portal
  reviews new requests; separate account suspension/revocation controls and
  payment/subscription automation are not part of this change.

## How to test locally

Use test accounts/properties and separate normal/private browser sessions.

1. Refresh the PMS and restart the backend if it is not automatically reloading.
2. Sign in as an unapproved Housekeeping/Front Desk/new account. Existing staff
   hotels still open with their assigned role, but Add property is absent.
   Direct property-creation API requests must return 403 until approval.
3. Submit a request for a total limit of 2. Note the PCR reference. A second
   pending submission must fail; another account must not see/cancel it.
4. Sign in as the nominated platform owner, open the portal, and locate that
   exact code. Hotel Owner/Admin accounts without platform permission must get
   403 on this portal's API.
5. Approve a total of 1 for a requester owning zero properties. Refresh their
   request page: approval, the same code and remaining 1 should appear. Add
   property should now be available on Your properties.
6. Create one disposable hotel. The requester becomes its owner; their role in
   any existing staff hotel stays unchanged. A second creation must return 409
   and the UI offers another request, including if the first hotel is inactive.
7. Submit a higher-limit request and reject it with a note. The requester sees
   the rejection and their previous approved quota remains unchanged. Also test
   cancellation before review and repeated approval attempts (409).

## Platform property management (2026-10-28)

The PMS owner portal now has an **All properties** tab at
`http://localhost:3000/platform/properties`. It lists existing properties across
accounts, with name/ID search, Active/Archived filters and server pagination.
Only an authenticated account with `platform_owner: true` can list or change
these properties. Hotel Owner/Admin, Front Desk, Housekeeping and legacy global
admin roles do not grant platform access. Listing metadata does not add the
platform owner to hotel staff or grant access to guests and financial records.

- **Rename** changes only `info.hotel_name`. The permanent `property_id`, MongoDB
  identity, hotel GUID, channel mapping ID, ownership and staff links remain.
  Rooms, reservations and invoices keep their existing references.
- **Archive** sets the property inactive and blocks property API access. It does
  not delete reservations, invoices, rooms, history or memberships. The property
  continues to count against its owner's approved creation limit.
- **Restore** reactivates the same property and existing staff access, retaining
  its records and identity. It does not create a replacement hotel.
- Every change requires a reason and the property's current version. Archive
  and Restore also require typing the current name. Stale changes return 409;
  close the form, refresh and review the current property before retrying.
- Changes and the authenticated platform actor are audited transactionally.
  Archive/Restore share the inventory transaction guard. Booking and financial
  saves using that guard cannot commit after an archive wins the guard. Other
  requests already authorized before archive may finish; new property requests
  are blocked by the active-status check.

Renaming passed database-backed checks without breaking room or reservation
links. Open pages may retain a cached name until refreshed, and already-sent
documents are not rewritten. Existing custom email text may contain a literal
old name; the reservation email client can also read cached property details,
and the mail route has preexisting hardcoded hotel-name fallbacks. Therefore,
this change does not guarantee that all outgoing email branding immediately
uses a renamed property. Review templates and refresh cached details separately.

Update 2026-10-29: Owner/Admin can now submit deletion requests that archive the
property only after platform approval. See [deletion requests and tests](property-deletion-requests.md).
No rename request is required; the existing Owner/Admin property-settings name
editor remains available.

### Test the property controls

1. Sign in to the nominated PMS platform account and open **PMS owner portal →
   All properties**. Existing hotels across accounts should appear. Normal
   **Your properties** remains limited to owned/shared hotels.
2. Use a disposable hotel. Rename it with a reason. Refresh its normal PMS
   view and check the room/reservation list; its URL/ID should remain the same.
3. Archive it by typing its current name and a reason. In a second owner/staff
   session, refresh: the archived hotel's API access must be denied.
4. Filter Archived in the platform portal, choose Restore, and confirm its
   current name/reason. The same owner/staff should regain access to the same
   records after refreshing. Its allowance usage should not change.
5. Open a rename/archive form in two platform sessions. Save one, then submit
   the stale form in the other: it must reject the stale change.
6. A regular hotel Owner/Admin or employee must not access this list or these
   mutations, even by directly calling the platform API.

## Verification

- All 246 backend tests passed. Focused `npm run check:access` now includes
  signup, approval/quota tests and syntax checks for the new route/service/model.
- Frontend TypeScript and isolated browser checks passed for request submission,
  shared codes, unauthorized review, approval, request status, quota-gated Add
  property, exhausted allowance and responsive request screens.
- Isolated desktop/mobile browser checks also passed for the all-properties
  list, rename, archive confirmation, stale-form blocking, archived filtering,
  restore and denied platform access. API responses were simulated for these
  UI checks; the separate MongoDB smoke exercised real database transactions.
- `npm run smoke:property-approvals` passed 65 checks against the configured
  MongoDB, including simultaneous last-slot creation, duplicate approval,
  metadata-only platform listing, rename with stable IDs/room/reservation links,
  stale versions, archive access blocking and restore with retained records,
  plus deletion requests/cancellation/revoked-admin review/concurrent approvals.
  Disposable users, requests, properties, rooms, reservations, guards and
  property audits were removed and cleanup verified. No real customer property
  was renamed or archived.
- The explicitly nominated real platform account received only the requested
  platform_owner flag through the audited server utility. No real account was
  given a property quota or an automatic request approval during setup.
- Production frontend build was not run against the active development server.

## API

- GET `/api/property-creation`: own allowance, own recent requests and contact defaults.
- POST `/api/property-creation/requests`: submit a pending request.
- POST `/api/property-creation/requests/:id/cancel`: cancel own pending request.
- GET `/api/property-creation/review?status=pending`: platform-owner review list.
- POST `/api/property-creation/review/:id/decision`: platform-owner approve/reject.
- POST `/api/properties`: existing creation endpoint, now enforces approved quota.
- GET `/api/platform/properties`: platform metadata list; supports page, limit,
  search and status (`all`, `active`, `inactive`).
- POST `/api/platform/properties/:propertyId/rename`: version, hotel_name, reason.
- POST `/api/platform/properties/:propertyId/archive`: version, confirm_name, reason.
- POST `/api/platform/properties/:propertyId/restore`: version, confirm_name, reason.
