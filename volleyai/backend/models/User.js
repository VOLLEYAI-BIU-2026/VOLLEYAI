const mongoose = require("mongoose");

const MyTeamPlayerSchema = new mongoose.Schema(
  {
    playerId: { type: String, required: true },
    jerseyNumber: { type: String, required: true },
    name: { type: String, default: "" },
    position: {
      type: String,
      enum: ["libero", "setter", "hitter", "blocker", ""],
      default: "",
    },
  },
  { _id: false }
);

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

    // Persistent, account-level roster — reused across matches via the
    // "Use My Team" toggle on the per-match Add Players screen, so the coach
    // doesn't have to retype jersey numbers/names/positions every upload.
    myTeamRoster: {
      teamName: { type: String, default: "" }, // coach-editable, reused as the default "Team A" whenever this roster is used
      players: {
        type: [MyTeamPlayerSchema],
        default: [],
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);