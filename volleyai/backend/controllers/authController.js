const bcrypt = require("bcryptjs");
const User = require("../models/User");
const crypto = require("crypto");
const sendEmail = require("../utils/sendEmail");
const { setAuthCookie, clearAuthCookie } = require("../utils/authCookie");

async function signup(req, res) {
  try {
    const emailNorm = (req.body.email || "").trim().toLowerCase();
    const { password } = req.body;

    if (!emailNorm || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const existing = await User.findOne({ email: emailNorm });
    if (existing) {
      return res.status(409).json({ message: "User already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      email: emailNorm,
      passwordHash,
      provider: "local",
    });

    setAuthCookie(res, { id: user._id.toString(), email: user.email });

    return res.status(201).json({
      message: "Signup success",
      user: { id: user._id, email: user.email, provider: user.provider },
    });
  } catch (error) {
    console.error("SIGNUP ERROR:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

async function login(req, res) {
  try {
    const emailNorm = (req.body.email || "").trim().toLowerCase();
    const { password } = req.body;

    if (!emailNorm || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: emailNorm });

    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (!user.passwordHash) {
      return res.status(400).json({ message: "This account uses Google sign-in" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    setAuthCookie(res, { id: user._id.toString(), email: user.email });

    return res.status(200).json({
      message: "Login success",
      user: { id: user._id, email: user.email, provider: user.provider },
    });
  } catch (error) {
    console.error("login error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

async function forgotPassword(req, res) {
  try {
    const emailNorm = (req.body.email || "").trim().toLowerCase();

    if (!emailNorm) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: emailNorm });

    if (!user || !user.passwordHash) {
      return res.status(200).json({
        message: "If an account exists, a reset link will be sent",
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");

    user.resetPasswordTokenHash = resetTokenHash;
    user.resetPasswordExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    const appUrl = process.env.APP_URL || "http://localhost:5173";
    const resetLink = `${appUrl}/reset-password?token=${resetToken}`;

    await sendEmail({
      to: user.email,
      subject: "VolleyAI - Reset your password",
      html: `
        <div style="font-family:Arial; line-height:1.6">
          <h2>Reset Password</h2>
          <p>Click the link below to reset your password (valid for 15 minutes):</p>
          <p><a href="${resetLink}">${resetLink}</a></p>
          <p>If you didn’t request this, ignore this email.</p>
        </div>
      `,
    });

    return res.status(200).json({
      message: "If an account exists, a reset link will be sent",
    });
  } catch (error) {
    console.error("forgotPassword error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ message: "Token and new password are required" });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    if (!user.passwordHash) {
      return res.status(400).json({ message: "This account uses Google sign-in" });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordExpiresAt = undefined;
    await user.save();

    return res.status(200).json({ message: "Password reset successful" });
  } catch (error) {
    console.error("resetPassword error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

async function googleAuth(req, res) {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "accessToken is required" });
    }

    const googleRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!googleRes.ok) {
      return res.status(401).json({ message: "Invalid Google token" });
    }

    const profile = await googleRes.json();

    const googleSub = profile.sub;
    const emailNorm = (profile.email || "").trim().toLowerCase();

    if (!googleSub || !emailNorm) {
      return res.status(400).json({ message: "Google profile missing required fields" });
    }

    let user = await User.findOne({ googleSub });

    if (!user) {
      user = await User.findOne({ email: emailNorm });

      if (user) {
        user.googleSub = googleSub;
        user.provider = user.provider || "local";
        await user.save();
      }
    }

    if (!user) {
      user = await User.create({ email: emailNorm, googleSub, provider: "google" });
    }

    setAuthCookie(res, { id: user._id.toString(), email: user.email });

    return res.status(200).json({
      message: "Google auth success",
      user: { id: user._id, email: user.email, provider: user.provider },
    });
  } catch (error) {
    console.error("googleAuth error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

async function me(req, res) {
  return res.status(200).json({
    user: { id: req.user.id, email: req.user.email },
  });
}

async function logout(req, res) {
  clearAuthCookie(res);
  return res.status(200).json({ message: "Logged out" });
}

async function getMyTeam(req, res) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.status(200).json({ players: user.myTeamRoster?.players || [] });
  } catch (error) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

async function addMyTeamPlayer(req, res) {
  try {
    const { jerseyNumber, name, position } = req.body;
    const trimmedJersey = (jerseyNumber || "").trim();
    if (!trimmedJersey) {
      return res.status(400).json({ message: "Jersey number is required" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.myTeamRoster) user.myTeamRoster = { players: [] };
    if (user.myTeamRoster.players.some((p) => p.jerseyNumber === trimmedJersey)) {
      return res.status(409).json({ message: `#${trimmedJersey} is already on your team.` });
    }

    const player = {
      playerId: `myteam_${Date.now()}`,
      jerseyNumber: trimmedJersey,
      name: (name || "").trim(),
      position: position || "",
    };
    user.myTeamRoster.players.push(player);
    await user.save();

    return res.status(201).json({ player, players: user.myTeamRoster.players });
  } catch (error) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

async function deleteMyTeamPlayer(req, res) {
  try {
    const { playerId } = req.params;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.myTeamRoster) user.myTeamRoster = { players: [] };
    user.myTeamRoster.players = user.myTeamRoster.players.filter((p) => p.playerId !== playerId);
    await user.save();

    return res.status(200).json({ players: user.myTeamRoster.players });
  } catch (error) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

module.exports = {
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
};