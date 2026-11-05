const test = require("node:test"), assert = require("node:assert/strict"), mongoose = require("mongoose");
const Property = require("../db_models/property.model"), User = require("../db_models/user.model"), Withdrawal = require("../db_models/withdrawal.model");
const { eligibleRecipientRole, resolveWithdrawalRecipient, listWithdrawalRecipients } = require("../services/withdrawal-recipient.service");
const { notificationSources, buildNotification, notificationTypesForRole } = require("../services/notification.service");

function fixture() {
  const ids = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
  return { ids, property: new Property({ property_id: "withdrawal-recipients", owner_id: ids[0], member_ids: [ids[1], ids[2]], administrator_ids: [ids[1]], staff_roles: [{ user_id: ids[2], role: "finance" }], info: { hotel_name: "Test", address: "Road", email: "hotel@example.test", country_code: "LK" } }) };
}
const query = value => ({ select() { return this; }, session() { return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

test("withdrawal recipients must be explicit property owners or administrators with current membership", () => {
  const { ids, property } = fixture();
  assert.equal(eligibleRecipientRole(property, ids[0]), "owner");
  assert.equal(eligibleRecipientRole(property, ids[1]), "administrator");
  assert.equal(eligibleRecipientRole(property, ids[2]), null);
  assert.equal(eligibleRecipientRole(property, ids[3]), null);
  property.member_ids.pull(ids[1]);
  assert.equal(eligibleRecipientRole(property, ids[1]), null);
  property.status = "inactive";
  assert.equal(eligibleRecipientRole(property, ids[0]), null);
});

test("recipient list returns minimal server identities and roles; unrelated and deleted accounts cannot resolve", async t => {
  const { ids, property } = fixture();
  const users = [{ _id: ids[0], name: "Actual Owner", email: "private@example.test" }, { _id: ids[1], name: "Actual Admin", email: "private2@example.test" }];
  t.mock.method(User, "find", filter => { assert.deepEqual(filter._id.$in.map(String).sort(), [ids[0], ids[1]].map(String).sort()); return query(users); });
  t.mock.method(User, "findById", id => query(users.find(user => String(user._id) === String(id)) || null));
  const recipients = await listWithdrawalRecipients(property);
  assert.deepEqual(recipients.map(user => [user.name, user.role]), [["Actual Owner", "owner"], ["Actual Admin", "administrator"]]);
  assert.ok(recipients.every(user => Object.keys(user).sort().join() === "name,role,user_id"));
  assert.equal((await resolveWithdrawalRecipient(property, String(ids[1]))).name, "Actual Admin");
  for (const value of [undefined, "ASIRI PERERA", String(ids[2]), String(ids[3])]) await assert.rejects(resolveWithdrawalRecipient(property, value), error => error.statusCode === 400);
  users.pop();
  await assert.rejects(resolveWithdrawalRecipient(property, String(ids[1])), /unavailable/);
});

test("withdrawal no longer supplies a fixed payee and retains explicit historical snapshots", async () => {
  const data = { property_id: "withdrawal-test", withdrawal_no: "WD-TEST", amount: 1000, source_account: "cash_on_hand", payment_method: "cash", reason: "Personal withdrawal", money_received_at: new Date() };
  await assert.rejects(new Withdrawal(data).validate(), error => Boolean(error.errors.paid_to));
  const legacy = new Withdrawal({ ...data, paid_to: "ASIRI PERERA" });
  await legacy.validate(); assert.equal(legacy.paid_to, "ASIRI PERERA"); assert.equal(legacy.recipient_user_id, undefined);
  const fresh = new Withdrawal({ ...data, paid_to: "Actual Owner", recipient_user_id: new mongoose.Types.ObjectId(), recipient_role: "owner" });
  await fresh.validate(); assert.equal(fresh.paid_to, "Actual Owner");
});

test("withdrawal notifications distinguish recipient and requester and remain unavailable to operational staff", () => {
  const record = { _id: new mongoose.Types.ObjectId(), withdrawal_no: "WD-TEST", paid_to: "Hotel Admin", recipient_role: "administrator", requested_by: { name: "Finance Person" }, status: "pending", currency: "LKR", amount: 1000, created_at: new Date() };
  const notification = buildNotification(notificationSources.find(source => source.type === "withdrawal"), record, "hotel-test");
  assert.match(notification.title, /awaiting approval/);
  assert.match(notification.message, /Requested recipient: Hotel Admin/);
  assert.match(notification.message, /Administrator/);
  assert.match(notification.message, /Requested by Finance Person/);
  for (const role of ["owner", "administrator", "finance"]) assert.ok(notificationTypesForRole(role).includes("withdrawal"));
  for (const role of ["front_desk", "housekeeping"]) assert.ok(!notificationTypesForRole(role).includes("withdrawal"));
});
