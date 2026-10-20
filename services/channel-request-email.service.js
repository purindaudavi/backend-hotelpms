const nodemailer = require("nodemailer");

function mailSettings() {
  const host = String(process.env.MAIL_HOST || "").trim();
  const user = String(process.env.MAIL_USER || "").trim();
  const password = String(process.env.MAIL_PASSWORD || "").trim();
  const port = Number(process.env.MAIL_PORT || 587);
  if (!host || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, user, password, port };
}

async function sendChannelRequestEmail({ to, subject, body }) {
  const settings = mailSettings();
  if (!settings || !to) return "not_configured";
  try {
    const transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      requireTLS: settings.port !== 465,
      auth: { user: settings.user, pass: settings.password },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000
    });
    await transporter.sendMail({ from: settings.user, to, subject, text: body });
    return "sent";
  } catch (error) {
    console.error("Channel request notification failed:", error.message);
    return "failed";
  }
}

async function notifyReviewTeam(request, kind = "new") {
  const to = String(process.env.CHANNEL_REQUEST_REVIEW_EMAIL || "").trim();
  return sendChannelRequestEmail({
    to,
    subject: `${kind === "reply" ? "Owner reply on" : "New"} ${request.provider} setup request for ${request.property_id}`,
    body: [
      kind === "reply" ? "The hotel owner replied to a request for more information." : "A hotel owner submitted a channel setup request.",
      `Property: ${request.property_id}`,
      `Provider: ${request.provider}`,
      `Provider property ID: ${request.provider_property_id || "Not provided"}`,
      `Request ID: ${request._id}`,
      "Sign in to the internal integration review queue to inspect it. No provider connection was created."
    ].join("\n")
  });
}

async function notifyHotelContact(request, note) {
  return sendChannelRequestEmail({
    to: request.contact_email,
    subject: `Channel setup request update: ${request.provider}`,
    body: [
      `Your ${request.provider} setup request for ${request.property_id} is now ${request.status.replaceAll("_", " ")}.`,
      note ? `Reviewer note: ${note}` : "",
      "Sign in to the PMS and open Channel Manager > Request to see the full history.",
      "This status does not mean a live provider connection is active."
    ].filter(Boolean).join("\n")
  });
}

module.exports = { notifyReviewTeam, notifyHotelContact };
