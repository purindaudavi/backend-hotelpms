require("dotenv").config();

const { connectDatabase, disconnectDatabase } = require("../config/database");
const User = require("../db_models/user.model");

async function main() {
  const emailIndex = process.argv.indexOf("--email");
  const email = emailIndex >= 0 ? String(process.argv[emailIndex + 1] || "").trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !process.argv.includes("--confirm")) {
    throw new Error("Usage: node scripts/grant-integration-reviewer.js --email person@example.com --confirm");
  }
  await connectDatabase();
  const user = await User.findOne({ email });
  if (!user) throw new Error("That account does not exist. Ask the reviewer to register first.");
  if (user.role === "integration_reviewer") {
    console.log(`${email} already has integration reviewer access.`);
    return;
  }
  if (user.role !== "user") {
    throw new Error(`Refusing to replace the existing ${user.role} role.`);
  }
  const result = await User.updateOne({ _id: user._id, role: "user" }, { $set: { role: "integration_reviewer" } });
  if (result.modifiedCount !== 1) throw new Error("The account role changed during provisioning. Check it before retrying.");
  console.log(`Granted integration reviewer access to ${email}. Ask them to sign out and sign in again.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => disconnectDatabase().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}));
