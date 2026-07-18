const express = require("express");
const router = express.Router();

const {
  signup,
  login,
  forgotPassword,
  resetPassword,
  googleAuth,
  me,
  logout,
  getMyTeam,
  addMyTeamPlayer,
  deleteMyTeamPlayer,
} = require("../controllers/authController");

const requireAuth = require("../requireAuth");

router.post("/signup", signup);
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/google", googleAuth);

router.get("/me", requireAuth, me);
router.post("/logout", logout);

router.get("/my-team", requireAuth, getMyTeam);
router.post("/my-team", requireAuth, addMyTeamPlayer);
router.delete("/my-team/:playerId", requireAuth, deleteMyTeamPlayer);

module.exports = router;