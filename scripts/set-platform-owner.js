// Trusted server operator utility. Public signup/profile routes cannot set this flag.
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const User = require("../db_models/user.model");
const { transaction } = require("../services/property-creation.service");
async function main() {
  const args = process.argv.slice(2);
  const email = (args[args.indexOf("--email") + 1] || "").trim().toLowerCase();
  if (!args.includes("--email") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (args.includes("--enable") === args.includes("--disable"))) {
    throw new Error("Usage: node scripts/set-platform-owner.js --email EMAIL --enable|--disable [--apply]");
  }
  await mongoose.connect(process.env.mongoURI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const user = await User.findOne({ email }).select("name email platform_owner");
  if (!user) { console.log(JSON.stringify({ found: false, email, message: "Register this account first. No privileges were changed." })); process.exitCode = 2; return; }
  const enabled = args.includes("--enable");
  if (args.includes("--apply")) await transaction(async session => {
    const current = await User.findById(user._id).session(session);
    if (current.platform_owner === enabled) return;
    await User.updateOne({ _id: user._id }, { $set: { platform_owner: enabled } }, { session });
    await mongoose.connection.collection("platform_access_audits").insertOne({ user_id: user._id, email, action: enabled ? "platform_owner_granted" : "platform_owner_revoked",
      previous: current.platform_owner === true, enabled, channel: "trusted_server_cli", created_at: new Date() }, { session });
  });
  console.log(JSON.stringify({ found: true, name: user.name, email: user.email, previous: user.platform_owner === true, requested: enabled, applied: args.includes("--apply") }));
}
main().catch(() => { console.error("Platform-owner setup failed. Check the arguments and database connectivity; no connection credentials are printed."); process.exitCode = 1; }).finally(() => mongoose.disconnect());
