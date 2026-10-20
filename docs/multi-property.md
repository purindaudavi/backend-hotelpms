# Property creation and switching

Sign in to the PMS and open the arrow next to the hotel name (also visible in the collapsed sidebar). Select **Manage / add properties**, then **Add property**. The same screen is available at `/properties`.

Enter the hotel name, contact email, address, country code, currency and timezone. Creation assigns a unique property ID and the signed-in account as owner. The new hotel opens in Property Details so you can add its logo, rooms and rates. Existing hotel records are not renamed, copied or deleted.

The property selector lists only hotels available to the signed-in account. Login restores that account's last selected hotel if access still exists, otherwise its first available hotel. Accounts with no hotels go to the property list.

## Staff access

On the property list, owners can select **Access** and enter an existing account's email. Members can operate that hotel but cannot grant or revoke access. Removing membership takes effect on subsequent API requests. The owner cannot be removed through this screen.

Existing properties without `owner_id` remain available to existing backend accounts with role `admin` or `developer`. Such administrators can grant staff access to those properties. An administrator does not automatically receive access to newly owned hotels. Public registration always creates role `user`; becoming a property owner does not require the global admin role.

No database migration is required. If an existing user cannot see an older hotel, an existing administrator should grant access. Do not rename the original property to create a second hotel.

## Data and API behavior

- Operational APIs require `Authorization: Bearer <access-token>` and a consistent property ID, provided by the URL for property endpoints, or `property_id` / `x-property-id` for other endpoints. Conflicting IDs are rejected.
- `GET /api/properties` lists authorized hotels. `POST /api/properties` creates a hotel and derives ownership from the verified account, never from the request body.
- `/api/properties/:propertyId/access` supports listing and granting membership; `DELETE /api/properties/:propertyId/access/:userId` revokes it. Access administration is owner-only.
- Authentication endpoints and health checks remain outside the property guard. Hotel/room image content remains public marketing media. Reservation attachments require authentication and are downloaded through the authenticated client.
- External scripts, including the local OTA simulator, now need a signed-in user's access token and a property ID. No OTA credentials are added by this change.
- New property room, booking, transaction and channel lists start empty. Legacy Ronaka values are not used as the new hotel's contact details. Existing persisted property records are preserved.
- New hotels do not display the original IBE sample rates. The IBE rate tab shows an empty integration state until an actual rate feed is implemented; minimum-stay room choices use the hotel's room catalog.
- Demo login can read the existing `demo` property's MongoDB data in development. It cannot write data, create hotels, manage access or read another property. Preview browser storage is separate from signed-in hotel caches. Production demo access is off unless `DEMO_WORKSPACE_ENABLED=true` is explicitly configured; only enable that with non-sensitive demo data. Sign in to manage real properties.
- On the main PMS Dashboard, leave the **Demo data** switch off to see MongoDB figures. Turning it on shows generated sample figures instead.

Start/restart the backend after updating. The PMS continues using its existing API URL and development port; this change does not reconfigure the landing-page server.

## Verification

`node --test test/property-access.test.js` exercises real HTTP routing with isolated database stubs: creation, ownership spoofing, restricted listing, membership grants/revocation, cross-property denial, scoped guest lookups and registration privilege restrictions. It does not mutate a live database.

Frontend checks cover property creation, empty room/booking state, selected-property persistence, expanded/collapsed switching, unauthorized URLs and mobile sizing with isolated API fixtures. Actual MongoDB persistence still requires the project's configured database and transaction support.
