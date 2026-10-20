# DMS Test Channel in Channel Manager

This is a development-only provider connection for a disposable hotel. It uses
the same basic boundary as an OTA integration: the PMS backend authenticates to
a separate provider service, sends room/rate mappings, and imports provider
bookings through an authenticated inbound API. It is **not** a live OTA.

## Configure both processes

Keep the separate `dms-test-channel` service running on `127.0.0.1:3601` with
its existing `TEST_PROPERTY_ID`, `TEST_CHANNEL_API_KEY`, and a current
`DMS_ACCESS_TOKEN` for a user who can access that hotel. Use a new random key;
do not reuse a key that was shown in a screenshot or shared in a chat.

In the PMS backend `.env`, set:

```dotenv
TEST_CHANNEL_PROPERTY_ID=hotel-your-disposable-test-property-id
TEST_CHANNEL_API_KEY=the-same-new-random-key-used-by-dms-test-channel
TEST_CHANNEL_URL=http://127.0.0.1:3601
```

Restart the PMS backend after changing its environment. `NODE_ENV=production`
disables this bridge. The backend only contacts a loopback HTTP address and
only accepts the configured test property.

## Run one test

1. In the test hotel, create an active room type, a physical room, and an active
   rate plan with a price for that room type.
2. In **Channel Manager → Channels**, find **DMS Test Channel**. Choose **Test
   connection**. It should show `Verified · Sync needed` if the provider is
   running and both keys match.
3. Choose **Sync rooms & rates**. The PMS backend sends the snapshot to the
   separate provider. Review the returned mappings on the Channels page. The
   status becomes `Connected · Test only` while that snapshot is available.
4. From the separate provider terminal, run `npm run show` to verify the same
   mappings, then use `npm run book -- <check-in> <check-out>` with dates inside
   the rate plan's validity period.
5. In **Channel Manager → Bookings**, refresh the main bookings table. It now
   shows imported provider reservations directly, with the source currency and
   real PMS audit history. The imported reservation also appears in the PMS's
   Reservations module. Repeat the provider request with the same external ID
   to test duplicate protection; use the provider's notes/cancel commands to
   test those paths.

The imported booking may have an invoice and a non-cash financial transaction,
but that does **not** represent a guest payment. The physical room remains
unassigned until hotel staff assigns it. The provider's snapshot is in memory:
restart the provider and you must sync again. Date-specific availability and
automatic rate-change delivery are **not** implemented. The provider's PMS
access token also expires and must be refreshed for new bookings.

The older Booking.com/Agoda/Expedia channel-configuration rows remain
browser-local examples. They are not live channel connections. The Channel
Manager Bookings table no longer includes browser-local sample bookings.
