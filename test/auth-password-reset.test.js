const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const User = require("../db_models/user.model");
const Session = require("../db_models/session.model");
const authRoutes = require("../routes/auth");

function query(value) {
  return {
    select() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}

async function startAuthServer(t) {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return (path, body) => fetch(`http://127.0.0.1:${server.address().port}/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("password reset emails an OTP, rejects invalid codes and consumes a valid OTP once", async (t) => {
  const account = new User({
    name: "Test User",
    email: "person@example.test",
    password: await bcrypt.hash("old-password", 10),
    mobile: "0771234567"
  });
  let deliveredEmail;
  let deliveryCount = 0;
  const sessionRevocations = [];
  process.env.MAIL_HOST = "smtp.example.test";
  process.env.MAIL_PORT = "587";
  process.env.MAIL_USER = "mailer@example.test";
  process.env.MAIL_PASSWORD = "test-mail-password";
  t.mock.method(User, "findOne", () => query(account));
  t.mock.method(User.prototype, "save", async function () { return this; });
  t.mock.method(User, "updateOne", async (filter, update) => {
    if (update.$inc) account.password_reset_otp_attempts += update.$inc.password_reset_otp_attempts;
    if (update.$unset) {
      for (const field of Object.keys(update.$unset)) account.set(field, undefined);
    }
    if (update.$set) Object.assign(account, update.$set);
    return { matchedCount: 1 };
  });
  t.mock.method(Session, "deleteMany", async (filter) => { sessionRevocations.push(filter); });
  t.mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message) => {
      deliveryCount += 1;
      deliveredEmail = message;
      return { messageId: "test-message" };
    }
  }));
  const request = await startAuthServer(t);

  const issued = await request("/forgot-password", { email: " PERSON@example.test " });
  assert.equal(issued.status, 200);
  assert.match(deliveredEmail.to, /person@example\.test/);
  const code = deliveredEmail.text.match(/\b\d{6}\b/)[0];
  assert.equal((await issued.text()).includes(code), false, "OTP is never returned in the HTTP response");
  assert.notEqual(account.password_reset_otp_hash, code, "OTP is stored as a hash");
  assert.equal((await request("/forgot-password", { email: account.email })).status, 200);
  assert.equal(deliveryCount, 1, "resend cooldown prevents immediate duplicate emails");

  const wrongCode = await request("/reset-password/verify-otp", {
    email: account.email, otp: "000000", newPassword: "new-password"
  });
  assert.equal(wrongCode.status, 400);
  assert.equal(account.password_reset_otp_attempts, 1);

  const reset = await request("/reset-password/verify-otp", {
    email: account.email, otp: code, newPassword: "new-password"
  });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.equal(await bcrypt.compare("new-password", account.password), true);
  assert.equal(account.password_reset_otp_hash, undefined, "successful verification consumes the OTP");
  assert.equal(sessionRevocations.length, 1, "password reset revokes existing sessions");
  assert.equal((await request("/reset-password/verify-otp", {
    email: account.email, otp: code, newPassword: "another-password"
  })).status, 400, "consumed OTP cannot be reused");
});

test("password reset requests do not reveal whether an email is registered", async (t) => {
  t.mock.method(User, "findOne", () => query(null));
  const request = await startAuthServer(t);

  const response = await request("/forgot-password", { email: "unknown@example.test" });
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /If an account exists/);
});

test("password reset OTPs expire and stop accepting guesses after five failures", async (t) => {
  const account = new User({
    name: "Test User",
    email: "person@example.test",
    password: await bcrypt.hash("old-password", 10),
    mobile: "0771234567",
    password_reset_otp_hash: await bcrypt.hash("123456", 10),
    password_reset_otp_expires_at: new Date(Date.now() - 1000),
    password_reset_otp_attempts: 0
  });
  t.mock.method(User, "findOne", () => query(account));
  const request = await startAuthServer(t);

  assert.equal((await request("/reset-password/verify-otp", {
    email: account.email, otp: "123456", newPassword: "new-password"
  })).status, 400, "expired code is rejected");

  account.password_reset_otp_expires_at = new Date(Date.now() + 60_000);
  account.password_reset_otp_attempts = 5;
  assert.equal((await request("/reset-password/verify-otp", {
    email: account.email, otp: "123456", newPassword: "new-password"
  })).status, 400, "OTP cannot be checked after the attempt limit");
});
