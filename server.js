require("dotenv").config();

const cors = require("cors");
const express = require("express");
const mailRoutes = require("./routes/mail");

const app = express();
const port = Number(process.env.PORT) || 3500;
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

app.use(cors({ origin: frontendOrigin }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("server is running");
});

app.use("/api", mailRoutes);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
