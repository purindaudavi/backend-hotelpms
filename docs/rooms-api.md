# Rooms API

Base URL: `http://localhost:3500/api/rooms`

Room types are the sellable categories used by Rates and Reservations. Physical
rooms are embedded under their room type. Shared image files are stored in
MongoDB GridFS and the room type stores only their metadata and GridFS IDs.

## Create a room type

`POST /api/rooms`

```json
{
  "property_id": "demo",
  "name": "deluxe new next",
  "maximum_adults": 2,
  "maximum_children": 0,
  "base_rate": 6500,
  "currency": "LKR",
  "description": "Two-room deluxe category.",
  "amenities": ["Air Conditioner", "Fan"],
  "active": true,
  "physical_rooms": [
    {
      "room_number": "16",
      "floor": "1",
      "operational_status": "available",
      "housekeeping_status": "clean",
      "active": true
    },
    {
      "room_number": "17",
      "floor": "1",
      "operational_status": "available",
      "housekeeping_status": "clean",
      "active": true
    }
  ]
}
```

## Read room data

- `GET /api/rooms?property_id=demo`
- `GET /api/rooms/:roomTypeId`
- `GET /api/rooms/physical-rooms?property_id=demo`

Every physical-room response includes the inherited `room_type_id` and
`room_type` name. They are not duplicated inside MongoDB.

## Update or disable a room type

- `PATCH /api/rooms/:roomTypeId`
- To disable it, send `{ "active": false }`.
- `DELETE /api/rooms/:roomTypeId` permanently removes it.

Deletion is rejected while a physical room is occupied unless `force=true` is
explicitly supplied.

## Manage physical rooms

- `POST /api/rooms/:roomTypeId/physical-rooms`
- `PATCH /api/rooms/:roomTypeId/physical-rooms/:physicalRoomId`
- `DELETE /api/rooms/:roomTypeId/physical-rooms/:physicalRoomId`

Operational statuses:

- `available`
- `occupied`
- `out_of_order`
- `maintenance`

Housekeeping statuses:

- `clean`
- `dirty`
- `inspected`
- `in_progress`

## Upload shared images

`POST /api/rooms/:roomTypeId/images`

Send the image as the raw request body, not JSON or Base64.

Headers:

```text
Content-Type: image/jpeg
x-file-name: deluxe-room.jpg
x-alt-text: Deluxe room with double bed
x-primary-image: true
```

JPEG, PNG, and WebP are accepted. The limit is 5 MB per image and 8 images per
room type.

The room-type response contains an image URL:

```json
{
  "images": [
    {
      "_id": "IMAGE_METADATA_ID",
      "filename": "deluxe-room.jpg",
      "content_type": "image/jpeg",
      "is_primary": true,
      "url": "http://localhost:3500/api/rooms/ROOM_TYPE_ID/images/IMAGE_METADATA_ID"
    }
  ]
}
```

Use the primary image URL directly as the card image in the frontend.

Image routes:

- `GET /api/rooms/:roomTypeId/images/:imageId`
- `PATCH /api/rooms/:roomTypeId/images/:imageId`
- `DELETE /api/rooms/:roomTypeId/images/:imageId`
