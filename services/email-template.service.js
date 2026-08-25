const EmailTemplate = require("../db_models/email-template.model");
const { EmailTemplateSettings } = require("../db_models/email-template.model");

const DEFAULT_EMAIL_TEMPLATES = {
  confirmation: defaultTemplate(
    "Booking Confirmation",
    "BOOKING CONFIRMATION",
    "Dear {{guestName}},\n\nThis is your confirmation email from {{hotelName}}.",
    "Reservation details",
    "Check-in: {{checkInDate}}\nCheck-out: {{checkOutDate}}\nDuration: {{nights}}\nRooms: {{roomsCount}}\nPayment: {{payment}}\nTotal: {{currency}} {{totalAmount}}\nSpecial requests: {{specialRequests}}",
    "Sign-off",
    "We look forward to welcoming you! If you have any questions, contact {{hotelName}} at {{hotelPhone}}."
  ),
  "check-in": defaultTemplate(
    "Check-in Information",
    "WELCOME - CHECK-IN",
    "Dear {{guestName}},\n\nYour reservation {{reservationNo}} is ready for check-in.",
    "Your stay details",
    "Reservation: {{reservationNo}}\nCheck-in: {{checkInDate}}\nCheck-out: {{checkOutDate}}\nNights: {{nights}}\nRooms: {{roomsCount}}\nTime and location: {{timeLocation}}\nWi-Fi network: {{wifiName}}\nWi-Fi password: {{wifiPassword}}\nSpecial requests: {{specialRequests}}",
    "Welcome to {{hotelName}}",
    "If you need assistance during your stay, contact our hotel at {{hotelPhone}}."
  ),
  "check-out": defaultTemplate(
    "Check-out Information",
    "THANK YOU FOR STAYING WITH US",
    "Dear {{guestName}},\n\nCheck-out details for reservation {{reservationNo}}.",
    "Your completed stay",
    "Reservation: {{reservationNo}}\nCheck-in: {{checkInDate}}\nCheck-out: {{checkOutDate}}\nDuration: {{nights}}\nFinal total: {{currency}} {{totalAmount}}\nPayment: {{payment}}",
    "We would love to welcome you again",
    "For future reservations, contact {{hotelName}} at {{hotelPhone}}."
  ),
  cancellation: defaultTemplate(
    "Cancellation Information",
    "BOOKING CANCELLED",
    "Dear {{guestName}},\n\nReservation {{reservationNo}} has been cancelled.",
    "Cancelled reservation details",
    "Reservation: {{reservationNo}}\nOriginal check-in: {{checkInDate}}\nOriginal check-out: {{checkOutDate}}\nRooms: {{roomsCount}}\nBooking source: {{bookingSource}}\nPayment: {{payment}}",
    "Need help with this cancellation?",
    "Contact {{hotelName}} at {{hotelPhone}} if you have any questions."
  ),
  reminder: defaultTemplate(
    "Reminder Information",
    "UPCOMING STAY REMINDER",
    "Dear {{guestName}},\n\nThis is a friendly reminder about reservation {{reservationNo}}.",
    "Upcoming reservation",
    "Reservation: {{reservationNo}}\nCheck-in: {{checkInDate}}\nCheck-out: {{checkOutDate}}\nNights: {{nights}}\nRooms: {{roomsCount}}\nBalance / payment: {{payment}}\nSpecial requests: {{specialRequests}}",
    "We look forward to welcoming you",
    "For changes or questions, contact {{hotelName}} at {{hotelPhone}}."
  ),
  "no-show": defaultTemplate(
    "No-show Notice - {{reservationNo}}",
    "WE MISSED YOU",
    "Dear {{guestName}},\n\nOur records show that you did not check in for reservation {{reservationNo}}.",
    "Reservation details",
    "Reservation: {{reservationNo}}\nScheduled check-in: {{checkInDate}}\nScheduled check-out: {{checkOutDate}}\nRooms: {{roomsCount}}\nTotal: {{currency}} {{totalAmount}}\nPayment status: {{payment}}",
    "Please contact us",
    "If this is incorrect or you need help, contact {{hotelName}} at {{hotelPhone}}."
  ),
  general: defaultTemplate(
    "{{subject}}",
    "{{subject}}",
    "Dear {{guestName}},",
    "Message",
    "{{message}}",
    "Kind regards",
    "{{hotelName}} - {{hotelPhone}}"
  )
};

async function resolveEmailTemplate({ propertyId, category, variables, fallbackHtml, fallbackSubject }) {
  if (!propertyId) return { html: fallbackHtml, subject: fallbackSubject, source: "default" };

  const settings = await EmailTemplateSettings.findOne({ property_id: propertyId }).lean();
  if (!settings || settings.use_default_templates !== false) {
    return { html: fallbackHtml, subject: fallbackSubject, source: "default" };
  }

  const template = await EmailTemplate.findOne({
    property_id: propertyId,
    category,
    active: true
  }).sort({ updated_at: -1 }).lean();

  if (!template) return { html: fallbackHtml, subject: fallbackSubject, source: "default-fallback" };
  return {
    html: renderCustomTemplate(template, variables),
    subject: renderSubject(template.subject, variables) || fallbackSubject,
    source: "custom",
    templateId: String(template._id)
  };
}

function renderCustomTemplate(template, variables = {}) {
  const color = categoryColor(template.category);
  const sections = template.blocks.map((block) => {
    const title = renderText(block.title, variables);
    const content = renderText(block.content, variables);
    const isHeader = block.kind === "header";
    const isFooter = block.kind === "footer";
    const background = isHeader ? color : isFooter ? "#f8fafc" : "#ffffff";
    const textColor = isHeader ? "#ffffff" : "#334155";
    const titleColor = isHeader ? "#ffffff" : "#111827";
    return `<tr><td style="padding:${isHeader ? "48px 36px" : "30px 40px"};background:${background};color:${textColor};text-align:${isHeader ? "center" : "left"}"><h2 style="margin:0 0 16px;color:${titleColor};font-size:${isHeader ? "30px" : "21px"};white-space:pre-line">${escapeHtml(title)}</h2><div style="font-size:16px;line-height:1.65;white-space:pre-line">${escapeHtml(content)}</div></td></tr>`;
  }).join("");

  return `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:25px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:700px;background:#fff;border-radius:15px;overflow:hidden">${sections}</table></td></tr></table></body></html>`;
}

function renderText(text, variables = {}) {
  return String(text || "").replace(/{{(\w+)}}/g, (_match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? `{{${key}}}` : String(value);
  });
}

function renderSubject(subject, variables) {
  return renderText(subject, variables).replace(/[\r\n]+/g, " ").trim().slice(0, 300);
}

function serializeTemplate(template) {
  return {
    id: String(template._id),
    propertyId: template.property_id,
    category: template.category,
    name: template.name,
    subject: template.subject,
    blocks: template.blocks.map((block) => ({
      id: block.block_id,
      kind: block.kind,
      title: block.title,
      content: block.content
    })),
    active: Boolean(template.active),
    updatedAt: template.updated_at
  };
}

function serializeDefaults() {
  return Object.entries(DEFAULT_EMAIL_TEMPLATES).map(([category, template]) => ({
    id: `default-${category}`,
    category,
    name: template.name,
    subject: template.subject,
    blocks: template.blocks.map((block) => ({ ...block })),
    active: false,
    updatedAt: null,
    builtIn: true
  }));
}

function defaultTemplate(subject, headerTitle, headerContent, bodyTitle, bodyContent, footerTitle, footerContent) {
  return {
    name: "Default",
    subject,
    blocks: [
      { id: "header", kind: "header", title: headerTitle, content: headerContent },
      { id: "reservation", kind: "reservation", title: bodyTitle, content: bodyContent },
      { id: "footer", kind: "footer", title: footerTitle, content: footerContent }
    ]
  };
}

function categoryColor(category) {
  return ({
    confirmation: "#04ff00",
    "check-in": "#0f766e",
    "check-out": "#2563eb",
    cancellation: "#b91c1c",
    reminder: "#b45309",
    "no-show": "#475569",
    general: "#6d28d9"
  })[category] || "#475569";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

module.exports = {
  DEFAULT_EMAIL_TEMPLATES,
  renderCustomTemplate,
  renderText,
  resolveEmailTemplate,
  serializeDefaults,
  serializeTemplate
};
