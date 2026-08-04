require("dotenv").config();

const cors = require("cors");
const express = require("express");
const mongoose = require("mongoose");
const { connectDatabase, disconnectDatabase } = require("./config/database");
const mailRoutes = require("./routes/mail");
const roomRoutes = require("./routes/rooms");
const guestRoutes = require("./routes/guest");
const bookingRoutes = require("./routes/bookings");
const createEventRoutes = require("./routes/create-event");
const crossBookingRoutes = require("./routes/crossbooking");
const reportRoutes = require("./routes/reports");

const app = express();
const port = Number(process.env.PORT) || 3500;
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

app.use(cors({ origin: frontendOrigin }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.send("server is running");
});

app.get("/api/health", (_req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? "ok" : "degraded",
    database: databaseConnected ? "connected" : "disconnected"
  });
});

app.use("/api", mailRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/guests", guestRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/events", createEventRoutes);
app.use("/api/cross-bookings", crossBookingRoutes);
app.use("/api/reports", reportRoutes);

async function startServer() {
  await connectDatabase();
  return app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

if (require.main === module) {
  let server;

  startServer()
    .then((runningServer) => {
      server = runningServer;
    })
    .catch((error) => {
      console.error(`Server failed to start: ${error.message}`);
      process.exitCode = 1;
    });

  async function shutdown(signal) {
    console.log(`${signal} received. Closing server.`);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectDatabase();
    process.exit(0);
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = {
  app,
  startServer
};
