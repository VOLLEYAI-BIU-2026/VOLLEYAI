const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String },
    googleSub: { type: String },
    provider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },

    resetPasswordTokenHash: { type: String },
    resetPasswordExpiresAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);