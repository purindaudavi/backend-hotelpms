const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const bcrypt = require("bcrypt");
const User = require("../db_models/user.model");
const authRoutes = require("../routes/auth");

test("signup accepts four account fields, preserves passwords and never self-assigns privileges", async (t) => {
  const accounts = [];
  t.mock.method(User, "findOne", async ({ email }) => accounts.find((item) => item.email === email));
  t.mock.method(User.prototype, "save", async function () { await this.validate(); accounts.push(this); return this; });
  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const register = (body) => fetch(`http://127.0.0.1:${server.address().port}/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const input = { name: " Cypsi ", email: " Cypsi@Example.test ", password: "test-password-123", mobile: " 0771234567 " };
  const created = await register(input);
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(accounts[0].name, "Cypsi");
  assert.equal(accounts[0].email, "cypsi@example.test");
  assert.equal(accounts[0].mobile, "0771234567");
  assert.equal(accounts[0].emp_no, "");
  assert.equal(accounts[0].role, "user");
  assert.notEqual(accounts[0].password, input.password);
  assert.equal(await bcrypt.compare(input.password, accounts[0].password), true);
  assert.equal((await register(input)).status, 400, "normalized duplicate email is rejected");
  assert.equal((await register({ ...input, email: "staff@example.test", role: "admin", emp_no: "self-assigned", owner_id: "fake-owner", platform_owner: true, property_creation_limit: 1000 })).status, 201);
  assert.equal(accounts[1].role, "user");
  assert.equal(accounts[1].platform_owner, false); assert.equal(accounts[1].property_creation_limit, 0);
  assert.equal(accounts[1].emp_no, "", "employee numbers are assigned outside public signup");
  assert.equal((await register({ ...input, mobile: " " })).status, 400);
  assert.equal((await register({ ...input, email: "invalid" })).status, 400);
  assert.equal((await register({ ...input, email: "short@example.test", password: "12345" })).status, 400);
  assert.equal((await register({ ...input, password: "😀".repeat(19) })).status, 400, "reject passwords bcrypt would silently truncate");
  assert.equal((await register({ ...input, password: { value: "invalid" } })).status, 400);
  assert.equal((await register({ ...input, name: "x".repeat(101) })).status, 400);
  assert.equal((await register({ ...input, mobile: "1".repeat(16) })).status, 400);
  assert.equal(accounts.length, 2, "failed validations do not create accounts");
});

test("existing employee numbers remain valid and new accounts do not require one", async () => {
  const input = { name: "Existing Staff", email: "existing@example.test", password: "hashed-password-placeholder", mobile: "0771234567" };
  const existing = new User({ ...input, emp_no: "STAFF-42" });
  await existing.validate();
  assert.equal(existing.emp_no, "STAFF-42");
  const newcomer = new User(input);
  await newcomer.validate();
  assert.equal(newcomer.emp_no, "");
});
