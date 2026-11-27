const IbeSettings = require("../db_models/ibe-settings.model");
const { RatePlan } = require("../db_models/rates.model");
const { SHARING_DEFAULTS } = require("./ibe-sharing.service");

async function getIbeSettings(propertyId) {
  const record = await IbeSettings.findById(propertyId).lean();
  return record ? serialize(record) : { version: 0, settings: null };
}

async function saveIbeSettings(propertyId, version, input) {
  if (!Number.isSafeInteger(version) || version < 0) invalid("A valid settings version is required.");
  const settings = validateIbeSettings(input);
  if (settings.config.ibeActive && settings.publicRatePlanId) {
    if (!settings.config.payAtProperty) invalid("Enable Pay at the Property to publish the booking page.");
    if (!await RatePlan.exists(publicRatePlanFilter(propertyId, settings.publicRatePlanId))) {
      invalid("Choose an active Room Only rate plan from this property.");
    }
  }
  if (version === 0) {
    try {
      return serialize(await IbeSettings.create({ _id: propertyId, settings, version: 1 }));
    } catch (error) {
      if (error.code !== 11000) throw error;
      conflict();
    }
  }

  const record = await IbeSettings.findOneAndUpdate(
    { _id: propertyId, version },
    { $set: { settings }, $inc: { version: 1 } },
    { new: true }
  ).lean();
  if (!record) conflict();
  return serialize(record);
}

function serialize(record) {
  return { version: record.version, settings: record.settings };
}

function publicRatePlanFilter(propertyId, planId) {
  return { _id: planId, property_id: propertyId, active: true, meal_plan: "Room Only" };
}

function validateIbeSettings(input) {
  const settings = object(input, "IBE settings");
  const requestedSharing = settings.publicSharing === undefined ? {} : object(settings.publicSharing, "Public data sharing");
  const publicSharing = Object.fromEntries(Object.entries(SHARING_DEFAULTS).map(([key, fallback]) => [
    key, requestedSharing[key] === undefined ? fallback : boolean(requestedSharing[key], "Public data sharing")
  ]));
  if (publicSharing.bookings && !publicSharing.availability) invalid("Enable room availability and rates before allowing online reservations.");
  let websiteOrigin = text(settings.websiteOrigin ?? "", "Website address", 300);
  if (websiteOrigin) {
    let website;
    try { website = new URL(websiteOrigin); } catch { invalid("Enter a valid HTTP or HTTPS website address."); }
    if (!["http:", "https:"].includes(website.protocol) || website.username || website.password) invalid("Enter a valid HTTP or HTTPS website address.");
    websiteOrigin = website.origin;
  }
  const config = object(settings.config, "Booking settings");
  const policies = object(settings.policies, "Policies");
  const smart = object(settings.smartPricing, "Smart pricing");
  const publicRatePlanId = text(settings.publicRatePlanId ?? "", "Online booking rate plan", 24).toLowerCase();
  if (publicRatePlanId && !/^[a-f\d]{24}$/.test(publicRatePlanId)) invalid("Choose a valid online booking rate plan.");
  const headerColour = text(config.headerColour, "Header colour", 7);
  if (!/^#[a-f\d]{6}$/i.test(headerColour)) invalid("Enter a header colour in #RRGGBB format.");
  const childAgeMin = number(config.childAgeMin, "Minimum child age", 0, 18, true);
  const childAgeMax = number(config.childAgeMax, "Maximum child age", childAgeMin, 18, true);
  const lowThreshold = number(smart.lowOccupancyThreshold, "Low occupancy threshold", 0, 100);
  const highThreshold = number(smart.highOccupancyThreshold, "High occupancy threshold", lowThreshold, 100);
  const minRateGuard = number(smart.minRateGuard, "Minimum rate", 0, 10000000);
  const maxRateGuard = number(smart.maxRateGuard, "Maximum rate", 0, 10000000);
  if (maxRateGuard && maxRateGuard < minRateGuard) invalid("Maximum rate must be at least the minimum rate.");

  const minStayRules = {};
  const rules = Object.entries(object(settings.minStayRules, "Minimum stays"));
  if (rules.length > 3000) invalid("Save up to 3,000 minimum stay rules per property.");
  for (const [key, value] of rules) {
    const match = /^([a-f\d]{24})::(\d{4}-\d{2}-\d{2})$/i.exec(key);
    if (!match || !isDate(match[2])) invalid("Each minimum stay needs a room type and a valid date.");
    minStayRules[key] = number(value, "Minimum stay", 1, 366, true);
  }

  return {
    publicSharing,
    websiteOrigin,
    publicRatePlanId,
    config: {
      headerColour,
      ibeActive: boolean(config.ibeActive, "IBE Active"),
      allowPay50: boolean(config.allowPay50, "Allow Pay 50%"),
      payAtProperty: boolean(config.payAtProperty, "Pay at the Property"),
      allowPayLater: boolean(config.allowPayLater, "Allow Pay Later"),
      payLaterDays: number(config.payLaterDays, "Pay Later Days", 0, 365, true),
      childFriendly: boolean(config.childFriendly, "Child Friendly"),
      childAgeMin,
      childAgeMax
    },
    policies: {
      cancellationPolicy: text(policies.cancellationPolicy, "Cancellation policy", 5000),
      childPolicy: text(policies.childPolicy, "Child policy", 5000),
      taxPolicy: text(policies.taxPolicy, "Tax policy", 5000)
    },
    packages: list(settings.packages, "Packages", validatePackage),
    minStayRules,
    promoCodes: list(settings.promoCodes, "Promo codes", validatePromo),
    smartPricing: {
      enabled: boolean(smart.enabled, "Smart Pricing Active"),
      baseAdjustmentPercent: number(smart.baseAdjustmentPercent, "Base adjustment", -100, 1000),
      weekendAdjustmentPercent: number(smart.weekendAdjustmentPercent, "Weekend adjustment", -100, 1000),
      highOccupancyThreshold: highThreshold,
      highOccupancyAdjustmentPercent: number(smart.highOccupancyAdjustmentPercent, "High occupancy adjustment", 0, 1000),
      lowOccupancyThreshold: lowThreshold,
      lowOccupancyDiscountPercent: number(smart.lowOccupancyDiscountPercent, "Low occupancy discount", 0, 100),
      minRateGuard,
      maxRateGuard
    },
    ibeHomeImage: rasterImage(settings.ibeHomeImage, "Banner"),
    logoImage: rasterImage(settings.logoImage, "Logo"),
    logoWidth: number(settings.logoWidth, "Logo width", 1, 4000, true),
    logoHeight: number(settings.logoHeight, "Logo height", 1, 4000, true),
    bannerOffsetX: number(settings.bannerOffsetX, "Banner offset X", -160, 160),
    bannerOffsetY: number(settings.bannerOffsetY, "Banner offset Y", -100, 100),
    bannerScale: number(settings.bannerScale, "Banner zoom", 1, 3)
  };
}

function validatePackage(item) {
  const imageUrl = text(item.imageUrl, "Package image URL", 500);
  if (imageUrl && !URL.canParse(imageUrl)) invalid("Enter a valid package image URL.");
  if (imageUrl && !["https:", "http:"].includes(new URL(imageUrl).protocol)) {
    invalid("Use an HTTP or HTTPS package image URL.");
  }
  return {
    id: text(item.id, "Package ID", 80, true),
    code: text(item.code, "Package code", 40, true),
    type: text(item.type, "Package type", 80, true),
    description: text(item.description, "Package description", 1000),
    price: number(item.price, "Package price", 0, 10000000),
    currency: text(item.currency, "Package currency", 60, true),
    duration: number(item.duration, "Package duration", 0, 366, true),
    minStay: number(item.minStay, "Package minimum stay", 0, 366, true),
    salesGlAccount: text(item.salesGlAccount, "Package sales account", 60, true),
    imageUrl
  };
}

function validatePromo(item) {
  const promoType = text(item.promoType, "Promo type", 40, true);
  if (!["Percentage", "Fixed Amount"].includes(promoType)) invalid("Choose a valid promo type.");
  const [bookingStartDate, bookingEndDate] = dateRange(item.bookingStartDate, item.bookingEndDate, "Booking period");
  const [stayStartDate, stayEndDate] = dateRange(item.stayStartDate, item.stayEndDate, "Stay period");
  return {
    id: text(item.id, "Promo ID", 80, true),
    code: text(item.code, "Promo code", 40, true).toUpperCase(),
    promoType,
    description: text(item.description, "Promo description", 1000),
    applyFor: text(item.applyFor, "Promo audience", 40, true),
    percentage: number(item.percentage, "Promo value", 0, promoType === "Percentage" ? 100 : 10000000),
    bookingStartDate,
    bookingEndDate,
    stayStartDate,
    stayEndDate,
    active: boolean(item.active, "Promo active"),
    showOnIbe: boolean(item.showOnIbe, "Show on IBE")
  };
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} are required.`);
  return value;
}

function list(value, label, validate) {
  if (!Array.isArray(value) || value.length > 50) invalid(`Save up to 50 ${label.toLowerCase()} per property.`);
  const items = value.map((item) => validate(object(item, label)));
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid(`${label} must have unique IDs.`);
  return items;
}

function text(value, label, maxLength, required = false) {
  if (typeof value !== "string" || value.length > maxLength || (required && !value.trim())) {
    invalid(`${label} must be ${required ? "between 1 and" : "at most"} ${maxLength} characters.`);
  }
  return value.trim();
}

function number(value, label, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    invalid(`${label} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max}.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") invalid(`${label} must be on or off.`);
  return value;
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateRange(start, end, label) {
  if (!isDate(start) || !isDate(end) || end < start) invalid(`${label} needs a valid start and end date.`);
  return [start, end];
}

function rasterImage(value, label) {
  if (value === "") return "";
  const match = typeof value === "string" && value.length <= 140000 &&
    /^data:image\/(jpeg|png|webp);base64,([a-z\d+/]+={0,2})$/i.exec(value);
  if (match) {
    const bytes = Buffer.from(match[2], "base64");
    const hex = bytes.subarray(0, 8).toString("hex");
    const valid = match[1] === "jpeg" ? hex.startsWith("ffd8ff") :
      match[1] === "png" ? hex === "89504e470d0a1a0a" :
        bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (valid && bytes.length <= 100 * 1024) return value;
  }
  invalid(`${label} must be a JPEG, PNG, or WebP image up to 100 KB.`);
}

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function conflict() {
  throw Object.assign(new Error("IBE settings changed on another device. Reload the saved settings before editing again."), {
    status: 409,
    code: "IBE_SETTINGS_CONFLICT"
  });
}

module.exports = { getIbeSettings, saveIbeSettings, publicRatePlanFilter };
