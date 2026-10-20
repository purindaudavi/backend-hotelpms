const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const ChannelConnectionRequest = require("../db_models/channel-connection-request.model");
const User = require("../db_models/user.model");
const routes = require("../routes/channel-connection-requests");
const internalRoutes = require("../routes/internal-channel-requests");

const ownerId = new mongoose.Types.ObjectId();

test("channel setup requests cannot claim a live connected state", async () => {
  const valid = new ChannelConnectionRequest({
    property_id: "hotel-one",
    provider: "Agoda",
    contact_name: "Hotel Owner",
    contact_email: "owner@example.test",
    created_by: ownerId
  });
  await valid.validate();
  assert.equal(valid.status, "submitted");
  valid.status = "connected";
  await assert.rejects(valid.validate(), /status/);
});

test("owner requests are property-scoped and members cannot submit them", async (t) => {
  const records = [];
  t.mock.method(ChannelConnectionRequest, "create", async (values) => {
    const record = new ChannelConnectionRequest(values);
    await record.validate();
    record.created_at = new Date();
    records.push(record);
    return record;
  });
  t.mock.method(ChannelConnectionRequest, "find", (filter) => ({
    sort() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve(records.filter((item) => !filter.property_id || item.property_id === filter.property_id)); }
  }));
  t.mock.method(ChannelConnectionRequest, "findOne", (filter) => Promise.resolve(records.find((item) =>
    item.property_id === filter.property_id && String(item._id) === String(filter._id)) || null));
  t.mock.method(ChannelConnectionRequest, "findById", (id) => Promise.resolve(records.find((item) => String(item._id) === String(id)) || null));
  t.mock.method(ChannelConnectionRequest.prototype, "save", async function () { return this; });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.propertyRole = req.get("x-test-role") || "member";
    req.authorizedProperty = { property_id: req.get("x-test-property") || "hotel-one" };
    req.workspaceUser = { _id: ownerId, role: req.get("x-test-user-role") || "user" };
    next();
  });
  app.use("/internal/channel-requests", internalRoutes);
  app.use("/channel-requests", routes);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/channel-requests`;
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", "x-test-role": "owner", ...options.headers }
  });
  const input = { provider: "Agoda", contact_name: "Hotel Owner", contact_email: "owner@example.test" };

  assert.equal((await request("", { method: "POST", body: JSON.stringify(input), headers: { "x-test-role": "member" } })).status, 403);
  assert.equal((await request("", { method: "POST", body: JSON.stringify({ ...input, provider: "Unverified OTA" }) })).status, 400);
  const created = await request("", { method: "POST", body: JSON.stringify(input) });
  assert.equal(created.status, 201);
  const createdPayload = await created.json();
  const record = createdPayload.request;
  assert.equal(createdPayload.review_notification, "not_configured");
  assert.equal(record.status, "submitted");
  assert.equal(record.property_id, "hotel-one");
  assert.deepEqual(record.history.map((item) => item.event), ["submitted"]);
  assert.equal((await (await request("")).json()).requests.length, 1);
  assert.equal((await (await request("", { headers: { "x-test-property": "hotel-two" } })).json()).requests.length, 0);
  const internalBase = `http://127.0.0.1:${server.address().port}/internal/channel-requests`;
  assert.equal((await fetch(internalBase)).status, 403, "hotel users cannot view the internal review queue");
  const reviewerHeaders = { "Content-Type": "application/json", "x-test-user-role": "integration_reviewer" };
  assert.equal((await (await fetch(internalBase, { headers: reviewerHeaders })).json()).requests.length, 1);
  assert.equal((await fetch(`${internalBase}/${record._id}/status`, {
    method: "PATCH", headers: reviewerHeaders, body: JSON.stringify({ status: "connected", note: "Not a real provider test" })
  })).status, 400, "reviewers cannot self-declare a live connection");
  const reviewed = await fetch(`${internalBase}/${record._id}/status`, {
    method: "PATCH", headers: reviewerHeaders, body: JSON.stringify({ status: "needs_information", note: "Please provide the provider property ID." })
  });
  assert.equal(reviewed.status, 200);
  const reviewedPayload = await reviewed.json();
  assert.equal(reviewedPayload.request.status, "needs_information");
  assert.equal(reviewedPayload.contact_notification, "not_configured");
  assert.equal((await (await request("")).json()).requests[0].history.at(-1).note, "Please provide the provider property ID.");
  const reply = await request(`/${record._id}/reply`, {
    method: "POST", body: JSON.stringify({ note: "Our provider property ID is AGD-12345." })
  });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).request.status, "in_review");
  assert.equal((await request(`/${record._id}/reply`, {
    method: "POST", body: JSON.stringify({ note: "This request no longer needs information." })
  })).status, 409);
  assert.equal((await request(`/${record._id}/cancel`, { method: "POST", headers: { "x-test-property": "hotel-two" } })).status, 404);
  const cancelled = await request(`/${record._id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200);
  assert.deepEqual((await cancelled.json()).request.history.map((item) => item.event), ["submitted", "needs_information", "owner_reply", "cancelled"]);
});

test("the internal queue requires a signed-in integration reviewer", async (t) => {
  process.env.JWT_SECRET = "channel-request-auth-test-secret";
  process.env.JWT_SECRET_REFRESH = "channel-request-refresh-test-secret";
  const reviewer = { _id: new mongoose.Types.ObjectId(), name: "Reviewer", email: "reviewer@example.test", role: "user" };
  t.mock.method(User, "findById", () => ({ select() { return Promise.resolve(reviewer); } }));
  t.mock.method(ChannelConnectionRequest, "find", () => ({
    sort() { return this; }, limit() { return this; }, lean() { return Promise.resolve([]); }
  }));
  const { app } = require("../app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/internal/channel-requests`;
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { Authorization: `Bearer ${jwt.sign({ id: String(reviewer._id) }, process.env.JWT_SECRET)}` };
  assert.equal((await fetch(endpoint, { headers })).status, 403);
  reviewer.role = "integration_reviewer";
  assert.equal((await fetch(endpoint, { headers })).status, 200);
});
