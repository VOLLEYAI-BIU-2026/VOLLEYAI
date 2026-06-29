const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const connectDB = require("./config/db");
require("dotenv").config();
const videoRoutes = require("./routes/videoRoutes");
const path = require("path");

connectDB();
const authRoutes = require("./routes/authRoutes");

const app = express();

app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
  })
);

app.use("/auth", authRoutes);
app.use("/videos", videoRoutes);
app.use("/uploads", express.static("uploads"));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/player-thumbs", express.static(path.join(__dirname, "detection_models", "all_three", "runs", "player_thumbs")));
app.use("/analysis-video", express.static(path.join(__dirname, "detection_models", "all_three", "runs")));

app.get("/", (req, res) => {
  res.send("API is running");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});