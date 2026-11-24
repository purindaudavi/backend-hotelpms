const nodemailer = require("nodemailer");

async function sendPasswordResetOtp({ to, name, otp }) {
  const host = String(process.env.MAIL_HOST || "").trim();
  const user = String(process.env.MAIL_USER || "").trim();
  const password = String(process.env.MAIL_PASSWORD || "").trim();
  const port = Number(process.env.MAIL_PORT || 587);
  if (!host || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Email delivery is not configured.");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass: password },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000
  });
  await transporter.sendMail({
    from: user,
    to,
    subject: "Password reset verification code",
    text: `Hello ${name},\n\nYour password reset verification code is ${otp}. It expires in 10 minutes. If you did not request this, you can ignore this email.\n`
  });
}

module.exports = { sendPasswordResetOtp };
