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
} = require("../controllers/authController");

const requireAuth = require("../requireAuth");

router.post("/signup", signup);
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/google", googleAuth);

router.get("/me", requireAuth, me);
router.post("/logout", logout);

module.exports = router;