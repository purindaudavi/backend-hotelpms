const test = require("node:test"), assert = require("node:assert/strict"), express = require("express");
const AuditLog = require("../db_models/booking-log.model");
const { activityFilter, dateBoundary, timezoneFor, serializeLog, exportCsv } = require("../services/activity-log.service");
const { authorizePropertyRequest } = require("../services/property-permissions.service");

test("activity filters use literal text, validate values and cannot override the authorized property", () => {
  const f = activityFilter("hotel-a", { property_id: "hotel-b", search: ".*", user: "a+b", entity_type: "reservation", action: "reservation_updated" }, "Asia/Colombo");
  assert.equal(f.property_id, "hotel-a"); assert.equal(f.entity_type, "reservation");
  assert.equal(f.$or[0].description.test("RES-anything"), false); assert.equal(f.$or[0].description.test("literal .* text"), true);
  assert.equal(f.$and[0].$or[0]["actor.name"].test("a+b"), true); assert.equal(f.$and[0].$or[0]["actor.name"].test("aaab"), false);
  for (const params of [{ search: { $ne: "" } }, { search: "x".repeat(201) }, { user: ["name"] }, { entity_type: "user_passwords" }, { action: "a.*" }, { date_from: "2026-02-30" }, { date_from: "2026-11-13", date_to: "2026-11-12" }]) assert.throws(() => activityFilter("hotel-a", params, "UTC"), { statusCode: 400 });
});

test("date filters include both hotel-local calendar dates with half-hour offsets and DST", () => {
  const f = activityFilter("hotel-a", { date_from: "2026-11-12", date_to: "2026-11-12" }, "Asia/Colombo");
  assert.equal(f.created_at.$gte.toISOString(), "2026-11-11T18:30:00.000Z"); assert.equal(f.created_at.$lt.toISOString(), "2026-11-12T18:30:00.000Z");
  const start = dateBoundary("2026-03-08", "America/New_York"), end = dateBoundary("2026-03-08", "America/New_York", true);
  assert.equal(end - start, 23 * 3600000);
  assert.equal(timezoneFor({ info: { timezone: "invalid-zone" } }), "Asia/Colombo");
});

test("activity details retain historical actor snapshots and hide credentials and file content", () => {
  const log = serializeLog({ _id: "log", entity_id: "record", actor: { name: "Former Employee", email: "old@example.test", user_id: "old-user" }, changes: [
    { field: "status", from: "confirmed", to: "checked_in" },
    { field: "api_key", from: "a-secret", to: "b-secret" },
    { field: "attachment", to: { name: "proof.pdf", data: "secret-file", nested: { password: "secret-password" } } }
  ] });
  assert.equal(log.actor.name, "Former Employee"); assert.deepEqual(log.changes[0], { field: "status", from: "confirmed", to: "checked_in" });
  assert.equal(log.changes[1].to, "[Hidden]"); assert.equal(log.changes[2].to.data, "[Hidden]"); assert.equal(log.changes[2].to.nested.password, "[Hidden]");
});

test("CSV quotes commas/newlines and prevents formula execution", () => {
  const csv = exportCsv([{ created_at: "2026-11-12T10:00:00Z", actor: { name: "=BAD()", email: "+mail" }, entity_type: "reservation", action: "updated", description: 'Guest, "A"\nUpdated', entity_id: "id" }], "Asia/Colombo");
  assert.ok(csv.startsWith("\uFEFF")); assert.ok(csv.includes('"\'=BAD()"')); assert.ok(csv.includes('"\'+mail"')); assert.ok(csv.includes('"Guest, ""A""\nUpdated"')); assert.ok(csv.includes("15:30:00"));
});

test("Activity Logs API enforces role boundaries, scopes listing/export, paginates and rejects mutation", async t => {
  let filter, order, skip = 0, limit, reads = 0, count = 3;
  const rows = Array.from({ length: 3 }, (_, i) => ({ _id: `log-${i}`, entity_id: `record-${i}`, entity_type: "reservation", action: "reservation_updated", description: `RES-${i} updated`, created_at: new Date("2026-11-12T10:00:00Z"), actor: { user_id: "staff", name: "Verified Staff" }, changes: [] }));
  t.mock.method(AuditLog, "find", query => { reads++; filter = query; skip = 0; return { select() { return this; }, sort(value) { order = value; return this; }, skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; }, lean() { return Promise.resolve(count > 5000 ? Array.from({ length: 5001 }, () => rows[0]) : rows.slice(skip, skip + limit)); } }; });
  t.mock.method(AuditLog, "countDocuments", query => { assert.equal(query.property_id, "hotel-authorized"); return Promise.resolve(count); });
  const app = express(); app.use((req, _res, next) => {
    const role = req.get("test-role"); req.propertyRole = role;
    req.workspaceUser = role === "demo" ? null : { _id: "request-user" };
    req.authorizedProperty = { property_id: "hotel-authorized", status: "active", owner_id: role === "owner" ? "request-user" : "real-owner", member_ids: role === "owner" ? [] : ["request-user"], administrator_ids: role === "administrator" ? ["request-user"] : [], staff_roles: [], info: { timezone: "Asia/Colombo" } };
    next();
  });
  app.use((req, res, next) => roleFor(req) === "demo" ? next() : authorizePropertyRequest(req, res, next));
  app.use("/activity-logs", require("../routes/activity-logs"));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r)); t.after(() => new Promise(r => server.close(r)));
  const call = (path = "", role = "owner", method = "GET") => fetch(`http://127.0.0.1:${server.address().port}/activity-logs${path}`, { method, headers: { "test-role": role } });
  for (const role of ["front_desk", "housekeeping", "finance", "member", "demo"]) { assert.equal((await call("", role)).status, 403); assert.equal((await call("/export", role)).status, 403); }
  assert.equal(reads, 0);
  let response = await call("?page=2&limit=2&property_id=hotel-attacker"); let body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.logs.length, 1); assert.equal(body.logs[0].id, "log-2"); assert.equal(body.total, 3); assert.equal(body.pages, 2); assert.equal(body.timezone, "Asia/Colombo"); assert.equal(filter.property_id, "hotel-authorized"); assert.deepEqual(order, { created_at: -1, _id: -1 });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  response = await call("?search=RES-0&user=Verified&entity_type=reservation", "administrator"); assert.equal(response.status, 200); assert.equal(filter.entity_type, "reservation"); assert.ok(filter.$and); assert.ok(filter.$or);
  response = await call("/export?search=RES-0"); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /text\/csv/); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.ok((await response.text()).includes("Verified Staff")); assert.ok(filter.$or);
  for (const query of ["?page=-1", "?limit=101", "?page=1.2", "?date_from=not-a-date", "?search=x&search=y"]) assert.equal((await call(query)).status, 400, query);
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await call("", "owner", method)).status, 403);
  count = 5001; response = await call("/export"); assert.equal(response.status, 422); assert.match((await response.json()).message, /Narrow/);
  function roleFor(req) { return req.get("test-role"); }
});
