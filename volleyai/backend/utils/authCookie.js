const jwt = require("jsonwebtoken");

function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

  res.cookie("access_token", token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie("access_token", {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
  });
}

module.exports = { setAuthCookie, clearAuthCookie };