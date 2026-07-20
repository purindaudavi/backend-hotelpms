const express = require("express");
const app = express();
const port = process.env.PORT || 3500;  

app.use(express.json());
require("dotenv").config();


app.get("/", (req, res) => {
  res.send("server is running");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

const mailRoutes = require('./routes/mail');

app.use('/api', mailRoutes);
