# Owner and administrator access

Implemented 2026-10-23 (Asia/Colombo). This is the first stage of staff roles.

## What is available

| Capability | Owner | Administrator | Existing general member |
| --- | --- | --- | --- |
| Existing PMS operational modules and property settings | Yes | Yes | Existing access retained |
| Channel setup requests and development test-channel sync | Yes | Yes | No |
| View property staff access | Yes | Yes | No |
| Add/remove general members | Yes | Yes | No |
| Appoint, demote or remove administrators | Yes | No | No |
| Change plan/trial metadata | Yes | No | No |

Roles belong to a property. The same account can administer one property and
be a general member of another. A property administrator does not become a
platform administrator or integration reviewer. Public registration uses only
name, email, password and mobile; it never assigns property permissions. Role
and employee-number fields have been removed from signup. New accounts have
no properties until they receive platform approval and create one, or receive
staff access from an existing hotel owner. Since 2026-10-28, creating properties
requires a separately approved account quota; hotel Owner/Admin roles alone do
not grant this. See [property creation approval](property-creation-approval.md).

Ownership cannot be reassigned through staff access or property settings.
Existing owners stay owners. Membership grants are backward compatible; no
database migration is required. Administrator IDs supplement `member_ids` and
cannot grant access without membership. Access changes and their audit records
are saved in a MongoDB transaction; role changes apply to the next API request
without waiting for a new JWT. Reload other open browser tabs to refresh labels.

Normal room, reservation and financial safeguards continue to apply to owners
and administrators. Removing access to one property does not remove an account
or its access to other properties.

## How to use it

1. Start/restart the backend with `npm run dev` in `hotelbackend` and the PMS
   frontend with `npm run dev` in `new-pms`, if they are not already running.
2. Sign in as the property's existing owner. Open **Your properties** (`/properties`).
3. Choose **Access** on that property's card, or open the hotel and choose
   **Settings → Users**. Both screens use the same persisted access records.
4. Enter an existing registered account's email and choose **Administrator**
   or **General member**, then choose **Grant access**.
5. For existing members, change the role using the selector beside their name.
   Use **Remove access** to revoke membership. The owner has no role selector
   or removal button.

## Manual acceptance test

Use separate browser profiles or a normal and private window so the owner and
staff sessions do not overwrite each other. Use a test property and accounts.

1. As owner, grant a second account Administrator access. Sign in with that
   account separately. Its property card and workspace show **Administrator**.
2. Open the property, reservations, housekeeping, finance and settings. Existing
   operations remain available, with the existing safety checks.
3. As administrator, open **Your properties → Access**. Add a third registered
   account as a general member and remove it. The administrator has no control
   to promote staff, demote/remove another administrator or remove the owner.
4. In administrator **Settings → Property → Property Info**, **Plan** and
   **On Trial** are disabled. Other property information can still be saved.
   The backend also rejects attempts to change plan/trial fields directly.
5. As owner, promote an existing member to Administrator, then demote them to
   General member. Reload that user's page. Their Access button disappears,
   and direct access-management API requests fail with 403.
6. As owner, revoke the administrator. Their next property API request is denied.
   After reloading, the property is absent from their property list.
7. If that account has another property, verify its separate role still works.
8. As owner, check `GET /api/properties/:propertyId/audit-log`. Access grants, role changes
   and revocations include the verified acting account.

## Automated verification

Run `npm run check:access` for syntax, permission and HTTP authorization tests.
Run `npm test` for the complete backend suite. In `new-pms`, run
`npm run typecheck -- --incremental false` and `npm run build`.

Authorization HTTP tests use real Express/JWT handling with isolated model
fixtures. They do not change hotel data or demonstrate a live database commit.

Verification completed on 2026-10-23: the backend suite and focused access tests
passed; frontend TypeScript checks passed; browser checks with isolated API
fixtures verified Owner/Admin/member controls, role-change requests and mobile
dark-mode layout. Live database testing with the accounts above remains for
your local acceptance check. A production frontend build was not run against
the active development server.

## API

- `GET /api/properties`: includes each property's `role` and `permissions`.
- `GET /api/properties/:propertyId/my-access`: own role and permissions.
- `GET /api/properties/:propertyId/access`: staff list (Owner/Admin).
- `POST /api/properties/:propertyId/access`: `{email, role}`; default role is
  `member`. Only the owner can grant `administrator`.
- `PATCH /api/properties/:propertyId/access/:userId`: `{role}`; Owner/Admin can
  change general-member/Front Desk roles; only owners change administrators.
- `DELETE /api/properties/:propertyId/access/:userId`: revoke access; only the
  owner can remove an administrator. The owner cannot be removed.

The general member role remains a compatibility role with broad operational
access. [Front Desk](front-desk-role.md) is now available with enforced operational
restrictions. [Housekeeping](housekeeping-role.md) now has its own restricted
workspace and an explicit attendant-to-login link. Manager, Finance and Reports
restrictions remain subsequent work. Do not treat general members
as department-restricted staff.

Plan/trial fields are existing property metadata. This change does not activate
subscription billing, payment processing or subscription property limits. Real
OTA integrations remain separate unfinished work.
