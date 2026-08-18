const express = require("express");
const mongoose = require("mongoose");
const Property = require("../db_models/property.model");
const { PropertyImage, MealAllocation } = require("../db_models/property.model");
const RoomType = require("../db_models/rooms.model");
const BookingAuditLog = require("../db_models/booking-log.model");
const {
  actorFromRequest,
  changesFromPayload,
  writeAuditLog
} = require("../services/booking-audit.service");

const router = express.Router();
const imageBodyParser = express.raw({
  type: ["image/jpeg", "image/png", "image/webp"],
  limit: "8mb"
});
const MAX_GALLERY_IMAGES = 20;

const PROPERTY_INFO_FIELDS = [
  "hotel_name",
  "pms_name",
  "hotel_type",
  "hotel_guid",
  "star_category",
  "on_trial",
  "plan",
  "description",
  "address",
  "city",
  "postal_code",
  "country_code",
  "phone",
  "email",
  "website",
  "check_in_time",
  "check_out_time",
  "home_currency",
  "language_code",
  "timezone",
  "invoice_footer",
  "invoice_notes",
  "cm_property_id",
  "cm_active",
  "latitude",
  "longitude",
  "ibe_logo_width",
  "ibe_logo_height"
];

const MEAL_ALLOCATION_FIELDS = [
  "name",
  "meal_plan",
  "currency",
  "adult_amounts",
  "child_amounts",
  "valid_from",
  "valid_to",
  "active",
  "notes"
];

const PROPERTY_THEME_FIELDS = [
  "accent_color",
  "reservation_status_colors.confirmed",
  "reservation_status_colors.tentative",
  "reservation_status_colors.checked_out",
  "reservation_status_colors.checked_in",
  "reservation_status_colors.cancelled",
  "reservation_status_colors.no_show",
  "reservation_status_colors.no_show_surcharge",
  "reservation_status_colors.blocked",
  "reservation_status_colors.out_of_order",
  "reservation_status_colors.invalid_card"
];

router.post("/", asyncHandler(async (req, res) => {
  const propertyId = requirePropertyId(req);
  const actor = actorFromRequest(req);
  const property = await inTransaction(async (session) => {
    const existing = await Property.findOne({ property_id: propertyId }).session(session);
    if (existing) throw httpError(409, "A property with this property_id already exists.");

    const record = new Property({
      property_id: propertyId,
      info: {},
      status: req.body?.status,
      created_by: actor,
      updated_by: actor
    });
    applyInfoPayload(record.info, req.body?.info || {});
    await record.save({ session });
    await writeAuditLog({
      propertyId,
      entityType: "property",
      entityId: record._id,
      action: "property_created",
      description: `Property ${record.info.hotel_name} was created.`,
      actor,
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(201).json({
    message: "Property created successfully.",
    property: await serializeProperty(property)
  });
}));

router.get("/:propertyId/audit-log", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const limit = Math.min(positiveInteger(req.query.limit, 100), 500);
  const logs = await BookingAuditLog.find({
    property_id: property.property_id,
    entity_type: "property",
    entity_id: property._id
  }).sort({ created_at: -1 }).limit(limit);

  return res.status(200).json({ count: logs.length, logs });
}));

router.get("/:propertyId/meal-allocations", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const query = { property_id: property.property_id };
  if (String(req.query.include_inactive || "").toLowerCase() !== "true") {
    query.active = true;
  }
  const allocations = await MealAllocation.find(query)
    .sort({ active: -1, valid_from: -1, meal_plan: 1, name: 1 });

  return res.status(200).json({
    count: allocations.length,
    meal_allocations: allocations.map(serializeMealAllocation)
  });
}));

router.post("/:propertyId/meal-allocations", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const actor = actorFromRequest(req);
  const allocation = new MealAllocation({
    property_id: property.property_id,
    created_by: actor,
    updated_by: actor
  });
  applyMealAllocationPayload(allocation, req.body || {});
  await allocation.validate();
  await assertNoMealAllocationOverlap(allocation);
  await allocation.save();

  await writeAuditLog({
    propertyId: property.property_id,
    entityType: "meal_allocation",
    entityId: allocation._id,
    action: "meal_allocation_created",
    description: `Meal allocation ${allocation.name} was created.`,
    actor,
    requestId: requestId(req)
  });

  return res.status(201).json({
    message: "Meal allocation created successfully.",
    meal_allocation: serializeMealAllocation(allocation)
  });
}));

router.patch("/:propertyId/meal-allocations/:allocationId", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const allocation = await findMealAllocation(property.property_id, req.params.allocationId);
  if (!allocation) throw httpError(404, "Meal allocation not found.");
  if (req.body?.version !== undefined && Number(req.body.version) !== allocation.version) {
    throw httpError(409, "Meal allocation changed after this page was loaded. Refresh and try again.");
  }

  const before = allocation.toObject({ virtuals: false });
  applyMealAllocationPayload(allocation, req.body || {});
  allocation.updated_by = actorFromRequest(req);
  await allocation.validate();
  await assertNoMealAllocationOverlap(allocation);
  await allocation.save();
  const after = allocation.toObject({ virtuals: false });
  const changes = changesFromPayload(before, after, MEAL_ALLOCATION_FIELDS);

  await writeAuditLog({
    propertyId: property.property_id,
    entityType: "meal_allocation",
    entityId: allocation._id,
    action: "meal_allocation_updated",
    description: `Meal allocation ${allocation.name} was updated.`,
    actor: allocation.updated_by,
    changes,
    requestId: requestId(req)
  });

  return res.status(200).json({
    message: "Meal allocation updated successfully.",
    meal_allocation: serializeMealAllocation(allocation)
  });
}));

router.delete("/:propertyId/meal-allocations/:allocationId", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const allocation = await findMealAllocation(property.property_id, req.params.allocationId);
  if (!allocation) throw httpError(404, "Meal allocation not found.");

  allocation.active = false;
  allocation.updated_by = actorFromRequest(req);
  await allocation.save();
  await writeAuditLog({
    propertyId: property.property_id,
    entityType: "meal_allocation",
    entityId: allocation._id,
    action: "meal_allocation_retired",
    description: `Meal allocation ${allocation.name} was retired.`,
    actor: allocation.updated_by,
    requestId: requestId(req)
  });

  return res.status(200).json({
    message: "Meal allocation retired successfully.",
    meal_allocation: serializeMealAllocation(allocation)
  });
}));

router.get("/:propertyId", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  return res.status(200).json({ property: await serializeProperty(property) });
}));

router.get("/:propertyId/theme", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  return res.status(200).json({ theme: serializePropertyTheme(property.theme) });
}));

router.patch("/:propertyId/theme", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const property = await inTransaction(async (session) => {
    const record = await requireProperty(req.params.propertyId, session);
    if (
      req.body?.version !== undefined &&
      Number(req.body.version) !== record.version
    ) {
      throw httpError(409, "Property settings changed after this page was loaded. Refresh and try again.");
    }

    const before = record.toObject({ virtuals: false });
    applyThemePayload(record.theme, req.body?.theme || req.body || {});
    record.updated_by = actor;
    await record.save({ session });
    const after = record.toObject({ virtuals: false });
    const changes = changesFromPayload(
      before,
      after,
      PROPERTY_THEME_FIELDS.map((field) => `theme.${field}`)
    );

    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "property",
      entityId: record._id,
      action: "property_theme_updated",
      description: `Appearance colors for ${record.info.hotel_name} were updated.`,
      actor,
      changes,
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(200).json({
    message: "Property appearance colors updated successfully.",
    theme: serializePropertyTheme(property.theme),
    version: property.version
  });
}));

router.get("/:propertyId/images", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const images = await PropertyImage.find({ property_id: property.property_id })
    .sort({ image_type: 1, is_primary: -1, sort_order: 1, created_at: 1 });

  return res.status(200).json({
    count: images.length,
    images: images.map((image) => serializeImage(image, req))
  });
}));

router.post("/:propertyId/images", imageBodyParser, asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(415).json({
      message: "Send a JPEG, PNG, or WebP file as the raw request body."
    });
  }

  const imageType = normalizeImageType(req.get("x-image-type"));
  if (!imageType) {
    return res.status(400).json({ message: "x-image-type must be logo or gallery." });
  }
  if (imageType === "gallery") {
    const count = await PropertyImage.countDocuments({
      property_id: property.property_id,
      image_type: "gallery"
    });
    if (count >= MAX_GALLERY_IMAGES) {
      return res.status(409).json({
        message: `A property can contain at most ${MAX_GALLERY_IMAGES} gallery images.`
      });
    }
  }

  const actor = actorFromRequest(req);
  const contentType = req.get("content-type");
  const filename = safeFilename(decodeHeader(req.get("x-file-name")) || `property-${Date.now()}`);
  const altText = decodeHeader(req.get("x-alt-text")).trim();
  const description = decodeHeader(req.get("x-description")).trim();
  const bucket = getPropertyImagesBucket();
  const uploaded = await uploadGridFsFile(bucket, req.body, {
    filename,
    contentType,
    metadata: { property_id: property.property_id, image_type: imageType }
  });

  let oldLogoFileId = null;
  let image;
  try {
    if (imageType === "logo") {
      const oldLogo = await PropertyImage.findOne({
        property_id: property.property_id,
        image_type: "logo"
      });
      oldLogoFileId = oldLogo?.file_id || null;
      image = await PropertyImage.findOneAndUpdate(
        { property_id: property.property_id, image_type: "logo" },
        {
          $set: {
            file_id: uploaded.id,
            filename,
            content_type: contentType,
            size: req.body.length,
            alt_text: altText,
            description,
            is_primary: true,
            sort_order: 0,
            updated_by: actor
          },
          $setOnInsert: {
            property_id: property.property_id,
            image_type: "logo",
            created_by: actor
          }
        },
        { new: true, upsert: true, runValidators: true }
      );
    } else {
      const makePrimary =
        String(req.get("x-primary-image") || "").toLowerCase() === "true" ||
        !(await PropertyImage.exists({
          property_id: property.property_id,
          image_type: "gallery",
          is_primary: true
        }));
      if (makePrimary) {
        await PropertyImage.updateMany(
          { property_id: property.property_id, image_type: "gallery" },
          { $set: { is_primary: false } }
        );
      }
      const sortOrder = await PropertyImage.countDocuments({
        property_id: property.property_id,
        image_type: "gallery"
      });
      image = await PropertyImage.create({
        property_id: property.property_id,
        file_id: uploaded.id,
        image_type: "gallery",
        filename,
        content_type: contentType,
        size: req.body.length,
        alt_text: altText,
        description,
        is_primary: makePrimary,
        sort_order: sortOrder,
        created_by: actor,
        updated_by: actor
      });
    }
  } catch (error) {
    await deleteGridFsFile(bucket, uploaded.id);
    throw error;
  }

  if (oldLogoFileId && !oldLogoFileId.equals(uploaded.id)) {
    await deleteGridFsFile(bucket, oldLogoFileId);
  }
  await writeAuditLog({
    propertyId: property.property_id,
    entityType: "property",
    entityId: property._id,
    action: imageType === "logo" ? "property_logo_saved" : "property_image_uploaded",
    description: imageType === "logo"
      ? `The official logo for ${property.info.hotel_name} was saved.`
      : `Property image ${filename} was uploaded.`,
    actor,
    requestId: requestId(req)
  });

  return res.status(201).json({
    message: imageType === "logo"
      ? "Official property logo saved successfully."
      : "Property image uploaded successfully.",
    image: serializeImage(image, req)
  });
}));

router.get("/:propertyId/images/:imageId/content", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const image = await findPropertyImage(property.property_id, req.params.imageId);
  if (!image) return res.status(404).json({ message: "Property image not found." });

  res.set({
    "Content-Type": image.content_type,
    "Content-Length": image.size,
    "Cache-Control": "public, max-age=86400",
    "Content-Disposition": `inline; filename="${safeFilename(image.filename)}"`
  });
  const stream = getPropertyImagesBucket().openDownloadStream(image.file_id);
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(error.code === "ENOENT" ? 404 : 500).json({
        message: error.code === "ENOENT"
          ? "Stored property image file not found."
          : "Property image could not be read."
      });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}));

router.patch("/:propertyId/images/:imageId", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const image = await findPropertyImage(property.property_id, req.params.imageId);
  if (!image) return res.status(404).json({ message: "Property image not found." });

  const payload = req.body || {};
  if (Object.prototype.hasOwnProperty.call(payload, "alt_text")) {
    image.alt_text = String(payload.alt_text || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, "description")) {
    image.description = String(payload.description || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, "sort_order")) {
    image.sort_order = payload.sort_order;
  }
  if (image.image_type === "gallery" && payload.is_primary === true) {
    await PropertyImage.updateMany(
      {
        property_id: property.property_id,
        image_type: "gallery",
        _id: { $ne: image._id }
      },
      { $set: { is_primary: false } }
    );
    image.is_primary = true;
  }
  image.updated_by = actorFromRequest(req);
  await image.save();

  return res.status(200).json({
    message: "Property image updated successfully.",
    image: serializeImage(image, req)
  });
}));

router.delete("/:propertyId/images/:imageId", asyncHandler(async (req, res) => {
  const property = await requireProperty(req.params.propertyId);
  const image = await findPropertyImage(property.property_id, req.params.imageId);
  if (!image) return res.status(404).json({ message: "Property image not found." });

  const wasPrimaryGallery = image.image_type === "gallery" && image.is_primary;
  const fileId = image.file_id;
  const imageType = image.image_type;
  const filename = image.filename;
  await image.deleteOne();
  await deleteGridFsFile(getPropertyImagesBucket(), fileId);

  if (wasPrimaryGallery) {
    const replacement = await PropertyImage.findOne({
      property_id: property.property_id,
      image_type: "gallery"
    }).sort({ sort_order: 1, created_at: 1 });
    if (replacement) {
      replacement.is_primary = true;
      await replacement.save();
    }
  }

  await writeAuditLog({
    propertyId: property.property_id,
    entityType: "property",
    entityId: property._id,
    action: imageType === "logo" ? "property_logo_deleted" : "property_image_deleted",
    description: imageType === "logo"
      ? `The official logo for ${property.info.hotel_name} was deleted.`
      : `Property image ${filename} was deleted.`,
    actor: actorFromRequest(req),
    requestId: requestId(req)
  });

  return res.status(200).json({ message: "Property image deleted successfully." });
}));

router.patch("/:propertyId/info", asyncHandler(async (req, res) => {
  const actor = actorFromRequest(req);
  const property = await inTransaction(async (session) => {
    const record = await requireProperty(req.params.propertyId, session);
    if (
      req.body?.version !== undefined &&
      Number(req.body.version) !== record.version
    ) {
      throw httpError(409, "Property settings changed after this page was loaded. Refresh and try again.");
    }

    const before = record.toObject({ virtuals: false });
    applyInfoPayload(record.info, req.body?.info || req.body || {});
    record.updated_by = actor;
    await record.save({ session });
    const after = record.toObject({ virtuals: false });
    const changes = changesFromPayload(
      before,
      after,
      PROPERTY_INFO_FIELDS.map((field) => `info.${field}`)
    );

    await writeAuditLog({
      propertyId: record.property_id,
      entityType: "property",
      entityId: record._id,
      action: "property_info_updated",
      description: `Property information for ${record.info.hotel_name} was updated.`,
      actor,
      changes,
      requestId: requestId(req),
      session
    });
    return record;
  });

  return res.status(200).json({
    message: "Property information updated successfully.",
    property: await serializeProperty(property)
  });
}));

function applyInfoPayload(info, payload) {
  for (const field of PROPERTY_INFO_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      info[field] = payload[field] === "" && ["latitude", "longitude"].includes(field)
        ? null
        : payload[field];
    }
  }
}

function applyThemePayload(theme, payload) {
  if (Object.prototype.hasOwnProperty.call(payload, "accent_color")) {
    theme.accent_color = payload.accent_color;
  }

  const colors = payload.reservation_status_colors;
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) return;

  for (const field of PROPERTY_THEME_FIELDS
    .filter((value) => value.startsWith("reservation_status_colors."))
    .map((value) => value.split(".")[1])) {
    if (Object.prototype.hasOwnProperty.call(colors, field)) {
      theme.reservation_status_colors[field] = colors[field];
    }
  }
}

function applyMealAllocationPayload(allocation, payload) {
  for (const field of ["name", "meal_plan", "currency", "valid_from", "valid_to", "active", "notes"]) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) allocation[field] = payload[field];
  }
  for (const audience of ["adult_amounts", "child_amounts"]) {
    if (!Object.prototype.hasOwnProperty.call(payload, audience)) continue;
    allocation[audience] = allocation[audience] || {};
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      if (Object.prototype.hasOwnProperty.call(payload[audience] || {}, meal)) {
        allocation[audience][meal] = payload[audience][meal];
      }
    }
  }
}

async function assertNoMealAllocationOverlap(allocation) {
  if (!allocation.active) return;
  const conflict = await MealAllocation.findOne({
    _id: { $ne: allocation._id },
    property_id: allocation.property_id,
    meal_plan: allocation.meal_plan,
    currency: allocation.currency,
    active: true,
    valid_from: { $lte: allocation.valid_to },
    valid_to: { $gte: allocation.valid_from }
  }).select("name valid_from valid_to");
  if (conflict) {
    throw httpError(
      409,
      `${allocation.meal_plan} already has an active ${allocation.currency} allocation (${conflict.name}) for overlapping dates.`
    );
  }
}

function serializeMealAllocation(allocation) {
  const value = allocation.toObject({ virtuals: true });
  return {
    ...value,
    valid_from: dateKey(value.valid_from),
    valid_to: dateKey(value.valid_to)
  };
}

function dateKey(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : "";
}

async function findMealAllocation(propertyId, allocationId) {
  if (!mongoose.isValidObjectId(allocationId)) return null;
  return MealAllocation.findOne({ _id: allocationId, property_id: propertyId });
}

async function serializeProperty(property) {
  const value = property.toObject({ virtuals: true });
  const roomTypes = await RoomType.find({ property_id: property.property_id })
    .select("physical_rooms.active")
    .lean();
  const physicalRoomCount = roomTypes.reduce(
    (count, roomType) =>
      count + (roomType.physical_rooms || []).filter((room) => room.active !== false).length,
    0
  );

  return {
    ...value,
    statistics: {
      physical_room_count: physicalRoomCount,
      room_type_count: roomTypes.length
    }
  };
}

function serializePropertyTheme(theme) {
  return {
    accent_color: theme.accent_color,
    reservation_status_colors: theme.reservation_status_colors.toObject
      ? theme.reservation_status_colors.toObject()
      : theme.reservation_status_colors
  };
}

function serializeImage(image, req) {
  return {
    ...image.toObject({ virtuals: true }),
    url: `${req.protocol}://${req.get("host")}${req.baseUrl}/${image.property_id}/images/${image._id}/content`
  };
}

async function findPropertyImage(propertyId, imageId) {
  if (!mongoose.isValidObjectId(imageId)) return null;
  return PropertyImage.findOne({ _id: imageId, property_id: propertyId });
}

function normalizeImageType(value) {
  const normalized = String(value || "gallery").trim().toLowerCase();
  return ["logo", "gallery"].includes(normalized) ? normalized : "";
}

function getPropertyImagesBucket() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new Error("MongoDB is not connected.");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "property_media"
  });
}

function uploadGridFsFile(bucket, buffer, { filename, contentType, metadata }) {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename, { contentType, metadata });
    stream.once("error", reject);
    stream.once("finish", () => resolve({ id: stream.id }));
    stream.end(buffer);
  });
}

async function deleteGridFsFile(bucket, fileId) {
  try {
    await bucket.delete(fileId);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function safeFilename(value) {
  return String(value || "property-image")
    .replace(/[\r\n"]/g, "")
    .replace(/[\\/]/g, "-")
    .slice(0, 255);
}

function decodeHeader(value) {
  const text = String(value || "");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

async function requireProperty(propertyId, session = null) {
  const normalized = String(propertyId || "").trim();
  if (!normalized) throw httpError(400, "propertyId is required.");
  const query = Property.findOne({ property_id: normalized });
  if (session) query.session(session);
  const property = await query;
  if (!property) throw httpError(404, "Property not found.");
  return property;
}

function requirePropertyId(req) {
  const propertyId = String(
    req.body?.property_id || req.get("x-property-id") || ""
  ).trim();
  if (!propertyId) {
    throw httpError(400, "property_id is required in the body or x-property-id header.");
  }
  return propertyId;
}

function requestId(req) {
  return String(req.get("x-request-id") || "").trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === "entity.too.large") {
    return res.status(413).json({ message: "The image exceeds the 8 MB limit." });
  }
  if (
    error instanceof mongoose.Error.ValidationError ||
    error instanceof mongoose.Error.CastError ||
    error.name === "BSONError"
  ) {
    return res.status(400).json({ message: firstValidationMessage(error) });
  }
  if (error?.code === 11000) {
    return res.status(409).json({
      message: error.keyPattern?.image_type
        ? "This property already has an official logo. Uploading a new logo replaces it."
        : "A property with this property_id already exists."
    });
  }
  return res.status(error.status || 500).json({
    message: error.status ? error.message : "Property request could not be completed."
  });
});

function firstValidationMessage(error) {
  const first = Object.values(error.errors || {})[0];
  return first?.message || error.message;
}

module.exports = router;
