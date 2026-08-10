const assert = require("node:assert/strict");
const test = require("node:test");
const TravelAgent = require("../db_models/travel-agents.model");

function validTravelAgent(overrides = {}) {
  return new TravelAgent({
    property_id: " demo ",
    name: " Global   Travels Ltd ",
    code: " gta-01 ",
    contact_person: " John   Smith ",
    agent_type: "Online Travel Agent",
    email: " SALES@GLOBALTRAVELS.COM ",
    phone: " +94 77 123 4567 ",
    commission_percentage: 12.5,
    status: "ACTIVE",
    ...overrides
  });
}

test("validates and normalizes a travel agent", async () => {
  const travelAgent = validTravelAgent();
  await travelAgent.validate();

  assert.equal(travelAgent.property_id, "demo");
  assert.equal(travelAgent.name, "Global Travels Ltd");
  assert.equal(travelAgent.code, "GTA-01");
  assert.equal(travelAgent.contact_person, "John Smith");
  assert.equal(travelAgent.agent_type, "online_travel_agent");
  assert.equal(travelAgent.email, "sales@globaltravels.com");
  assert.equal(travelAgent.status, "active");
});

test("requires a name, code and valid agent type", async () => {
  await assert.rejects(
    validTravelAgent({ name: "", code: "", agent_type: "unknown" }).validate(),
    /name is required|code is required|Agent type is invalid/
  );
});

test("rejects invalid commission, email and phone values", async () => {
  await assert.rejects(
    validTravelAgent({ commission_percentage: 101 }).validate(),
    /cannot exceed 100/
  );
  await assert.rejects(
    validTravelAgent({ email: "not-an-email" }).validate(),
    /email address is invalid/
  );
  await assert.rejects(
    validTravelAgent({ phone: "123" }).validate(),
    /between 7 and 20 digits/
  );
});

test("accepts optional blank contact details", async () => {
  const travelAgent = validTravelAgent({ email: "", phone: "" });
  await travelAgent.validate();

  assert.equal(travelAgent.email, "");
  assert.equal(travelAgent.phone, "");
});
